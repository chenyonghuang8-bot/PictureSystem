import { chmodSync, copyFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  acquireCheckedConnection,
  createDatabase,
  MySqlSystemRunRepository,
} from "../../packages/db/src/index.js";
import { InProcessControlOwner } from "../helpers/in-process-control-owner.js";
import { restartBuiltControlApi } from "../helpers/restart-built-control-api.js";
if (!process.env.DATABASE_URL) throw Error("PHASE11_DEV_DB_REQUIRED");
describe.sequential(
  "R1 actual CLEAN certificate drift rejects automatic startup",
  () => {
    for (const boundary of [
      "MISSING_METADATA",
      "RUN_LOCK_INODE",
      "CLEAN_MANIFEST",
      "CURRENT_REVISION",
    ] as const)
      it(`${boundary} requires the original authorized fresh RECHECK`, async () => {
        const db = createDatabase(process.env.DATABASE_URL!);
        let owner: InProcessControlOwner | undefined,
          api: Awaited<ReturnType<typeof restartBuiltControlApi>> | undefined;
        const recovered: string[] = [];
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
          const prior = await runs.observeCurrent();
          expect(prior?.phase).toBe("CLEAN");
          if (boundary === "RUN_LOCK_INODE") {
            const path = join(h.gate.namespace.path, "run.lock"),
              retained = join(h.container, "retained-run.lock");
            renameSync(path, retained);
            copyFileSync(retained, path);
            chmodSync(path, 0o600);
          } else if (boundary === "CLEAN_MANIFEST") {
            const c = await acquireCheckedConnection(db.pool);
            try {
              await c.query(
                "UPDATE system_control_runs SET member_manifest=UNHEX(REPEAT('00',32)) WHERE id=? AND phase='CLEAN'",
                [prior!.id],
              );
            } finally {
              c.release();
            }
          } else if (boundary === "CURRENT_REVISION")
            recovered.push(await h.beginRecheck());
          api = await restartBuiltControlApi(h, media, {
            requireMetadata: boundary === "MISSING_METADATA",
          });
          const current = await runs.observeCurrent();
          expect(current?.id).not.toBe(prior?.id);
          expect(Boolean(current?.automatic)).toBe(false);
          expect(current?.phase).toBe("RECOVERY_REQUIRED");
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
                name: "synthetic-certificate-drift",
                visibility: "FAMILY",
              }),
            });
          expect((await write()).status).toBe(503);
          if (boundary === "MISSING_METADATA") {
            await delay(300);
            expect((await runs.observeCurrent())?.phase).toBe(
              "RECOVERY_REQUIRED",
            );
            await api.stop();
            api = undefined;
            expect((await runs.observeCurrent())?.phase).not.toBe("CLEAN");
            api = await restartBuiltControlApi(h, media);
          }
          await h.recheck();
          expect((await runs.observeCurrent())?.phase).toBe("ACTIVE");
          expect((await h.repository.readCurrent()).enforcedMode).toBe(
            "READ_ONLY",
          );
          expect((await write()).status).toBe(503);
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
            else await owner.fixture.cleanup(recovered);
          }
          await db.pool.end();
        }
      }, 90000);
  },
);
