import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it, expect } from "vitest";
import {
  createDatabase,
  MySqlSystemRunRepository,
  type RowDataPacket,
} from "../../packages/db/src/index.js";
import { InProcessControlOwner } from "../helpers/in-process-control-owner.js";
import { restartBuiltControlApi } from "../helpers/restart-built-control-api.js";

if (!process.env.DATABASE_URL) throw Error("PHASE11_DEV_DB_REQUIRED");
describe.sequential(
  "R1 actual built API run-record lost COMMIT response",
  () => {
    it.each(["BEGIN", "AUTO_ACTIVE", "STOPPING", "ACK", "CLEAN"] as const)(
      "observes %s once without replay and preserves CLEAN consumption",
      async (stage) => {
        const db = createDatabase(process.env.DATABASE_URL!);
        let owner: InProcessControlOwner | undefined,
          api: Awaited<ReturnType<typeof restartBuiltControlApi>> | undefined,
          albumId: string | undefined;
        const evidencePath = resolve(
          `.cache/phase11-r1/built-record-loss-${stage}-${randomUUID()}.json`,
        );
        try {
          owner = await InProcessControlOwner.start(db.pool, []);
          const runs = new MySqlSystemRunRepository(db.pool),
            before = await runs.observeCurrent();
          const media = await owner.withResources(async (r) => {
            if (r.capability.state !== "READ_WRITE")
              throw Error("FIXTURE_ROOT_REQUIRED");
            return {
              path: r.capability.root.canonicalPath,
              marker: r.capability.root.markerId,
            };
          });
          await owner.releaseForApiRestart();
          expect((await runs.observeCurrent())?.phase).toBe("CLEAN");
          api = await restartBuiltControlApi(owner.fixture, media, {
            recordLoss: { stage, evidencePath },
          });
          const deadline = Date.now() + 12000;
          while ((await runs.observeCurrent())?.phase !== "ACTIVE") {
            if (Date.now() > deadline)
              throw Error("OBSERVED_BUILT_RUN_NOT_ACTIVE");
            await delay(100);
          }
          const active = await runs.observeCurrent();
          expect(active?.predecessor_id).toBe(before?.id);
          expect(String(active?.epoch)).toBe(
            String(BigInt(String(before?.epoch)) + 1n),
          );
          const [consumed] = await db.pool.query<RowDataPacket[]>(
            "SELECT phase FROM system_control_runs WHERE id=?",
            [before?.id],
          );
          expect(consumed[0]?.phase).toBe("CONSUMED");
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
          const write = await fetch(api.base + "/api/v1/albums", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              familyId: owner.fixture.syntheticIdentity.familyId,
              name: "synthetic-built-record-loss",
              visibility: "FAMILY",
            }),
          });
          expect(write.status).toBe(201);
          albumId = (await write.json()).id;
          await owner.fixture.request("READ_ONLY");
          await api.stop();
          api = undefined;
          const clean = await runs.observeCurrent();
          expect(clean?.id).toBe(active?.id);
          expect(clean?.phase).toBe("CLEAN");
          const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
          expect(evidence.stage).toBe(stage);
          expect(evidence.matchingCommits).toBe(1);
          expect(evidence.lostReplies).toBe(1);
          expect(evidence.destroys).toBe(1);
          expect(evidence.returned).toBeGreaterThanOrEqual(1);
          const [audit] = await db.pool.query<RowDataPacket[]>(
            "SELECT action,COUNT(*) n FROM admin_audit_events WHERE scope='SYSTEM' AND operation_id IN (?,?) GROUP BY action",
            [clean!.startup_operation_id, clean!.shutdown_operation_id],
          );
          expect(audit.map((r) => [r.action, String(r.n)]).sort()).toEqual([
            ["RUN_CLEAN_CLOSED", "1"],
            ["RUN_STARTED", "1"],
            ["RUN_STOPPING", "1"],
            ["STARTUP_AUTO_CONFIRMED", "1"],
          ]);
        } finally {
          if (api && owner) {
            try {
              await owner.fixture.request("READ_ONLY");
            } finally {
              await api.stop();
            }
          }
          if (albumId && owner)
            await db.pool.query(
              "DELETE FROM albums WHERE id=? AND family_id=? AND name=?",
              [
                albumId,
                owner.fixture.syntheticIdentity.familyId,
                "synthetic-built-record-loss",
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
  },
);
