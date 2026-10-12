import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  createDatabase,
  MySqlSystemRunRepository,
  type RowDataPacket,
} from "../../packages/db/src/index.js";
import { InProcessControlOwner } from "../helpers/in-process-control-owner.js";
import { restartBuiltControlApi } from "../helpers/restart-built-control-api.js";

if (!process.env.DATABASE_URL) throw Error("PHASE11_DEV_DB_REQUIRED");
async function until(check: () => Promise<boolean>, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= end) throw Error("RUN_BOUNDARY_UNCONFIRMED");
    await delay(50);
  }
}
describe.sequential(
  "R1 actual built run crash and terminal-proof failures",
  () => {
    for (const stage of [
      "PREPARING",
      "ACTIVE",
      "STOPPING",
      "CLOSE_FAILURE",
      "CLEAN_AUDIT_FAILURE",
    ] as const)
      it(`${stage} cannot authorize a successor without fresh RECHECK`, async () => {
        const db = createDatabase(process.env.DATABASE_URL!);
        const folder = mkdtempSync(
          join(realpathSync(tmpdir()), "phase11-r1-boundary-"),
        );
        const evidencePath = join(folder, "boundary.json");
        let owner: InProcessControlOwner | undefined;
        let api: Awaited<ReturnType<typeof restartBuiltControlApi>> | undefined;
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
          api = await restartBuiltControlApi(
            h,
            media,
            stage === "ACTIVE"
              ? {}
              : { failureBoundary: { stage, evidencePath } },
          );
          if (stage === "PREPARING") {
            await until(async () => existsSync(evidencePath));
            expect((await runs.observeCurrent())?.phase).toBe("PREPARING");
          } else
            await until(
              async () => (await runs.observeCurrent())?.phase === "ACTIVE",
            );
          const faultRun = await runs.observeCurrent();
          if (stage === "PREPARING" || stage === "ACTIVE") await api.crash();
          else {
            const stopping = api.stop();
            if (stage === "STOPPING") {
              await until(async () => existsSync(evidencePath));
              expect((await runs.observeCurrent())?.phase).toBe("STOPPING");
              await api.crash();
            }
            await stopping;
            expect(
              JSON.parse(readFileSync(evidencePath, "utf8")).boundaryReached,
            ).toBe(true);
          }
          api = undefined;
          expect((await runs.observeCurrent())?.phase).not.toBe("CLEAN");
          const [audit] = await db.pool.query<RowDataPacket[]>(
            "SELECT COUNT(*) n FROM admin_audit_events a JOIN system_control_runs r ON r.shutdown_operation_id=a.operation_id WHERE r.id=? AND a.action='RUN_CLEAN_CLOSED'",
            [faultRun!.id],
          );
          expect(String(audit[0]?.n)).toBe("0");
          api = await restartBuiltControlApi(h, media);
          const login = await fetch(api.base + "/api/v1/auth/android/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              username: h.syntheticIdentity.username,
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
                familyId: h.syntheticIdentity.familyId,
                name: "synthetic-run-boundary",
                visibility: "FAMILY",
              }),
            });
          expect((await write()).status).toBe(503);
          await h.recheck();
          expect((await h.repository.readCurrent()).enforcedMode).toBe(
            "READ_ONLY",
          );
          expect((await write()).status).toBe(503);
          expect((await runs.observeCurrent())?.phase).toBe("ACTIVE");
        } finally {
          if (api && owner) {
            try {
              await owner.fixture.request("READ_ONLY");
            } finally {
              await api.stop();
            }
          }
          if (owner) {
            if (owner.owner.resources.isAvailable())
              await owner.close({ recheck: true });
            else await owner.cleanupReleasedOwner();
          }
          await db.pool.end();
          rmSync(folder, { recursive: true, force: true });
        }
      }, 90000);
  },
);
