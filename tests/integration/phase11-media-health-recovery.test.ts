import { existsSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  createDatabase,
  MySqlSystemRunRepository,
  type RowDataPacket,
} from "../../packages/db/src/index.js";
import { StorageRoot } from "../../packages/storage/src/index.js";
import { InProcessControlOwner } from "../helpers/in-process-control-owner.js";
import { restartBuiltControlApi } from "../helpers/restart-built-control-api.js";
if (!process.env.DATABASE_URL) throw Error("PHASE11_DEV_DB_REQUIRED");
async function until(check: () => Promise<boolean>, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end)
      throw Error("ACTUAL_MEDIA_HEALTH_BOUNDARY_UNCONFIRMED");
    await delay(50);
  }
}
describe.sequential(
  "Phase11 actual built API synthetic media identity and fresh recovery",
  () => {
    for (const boundary of ["MISSING_ROOT", "REPLACED_ROOT"] as const)
      it(`${boundary} denies real writes and failed fresh recovery until the original identity returns`, async () => {
        const db = createDatabase(process.env.DATABASE_URL!);
        let owner: InProcessControlOwner | undefined,
          api: Awaited<ReturnType<typeof restartBuiltControlApi>> | undefined,
          media: { path: string; marker: string } | undefined,
          moved = "",
          rejected = "",
          albumId: string | undefined;
        const negativeOperations: string[] = [];
        const restore = () => {
          if (!moved || !existsSync(moved)) return;
          if (media && existsSync(media.path)) renameSync(media.path, rejected);
          renameSync(moved, media!.path);
        };
        try {
          owner = await InProcessControlOwner.start(db.pool, []);
          const h = owner.fixture,
            runs = new MySqlSystemRunRepository(db.pool);
          media = await owner.withResources(async (r) => {
            if (r.capability.state === "UNAVAILABLE")
              throw Error("ACTUAL_SYNTHETIC_ROOT_REQUIRED");
            return {
              path: r.capability.root.canonicalPath,
              marker: r.capability.root.markerId,
            };
          });
          const nonce = randomUUID();
          moved = `${media.path}.disconnected-${nonce}`;
          rejected = `${media.path}.rejected-${nonce}`;
          writeFileSync(
            `.cache/phase11-r1/media-health-${h.env.DEV_CONTROL_DEPLOYMENT_ID}.json`,
            JSON.stringify({
              deploymentId: h.env.DEV_CONTROL_DEPLOYMENT_ID,
              media,
              moved,
              rejected,
              boundary,
              synthetic: true,
            }),
            { mode: 0o600 },
          );
          await owner.releaseForApiRestart();
          api = await restartBuiltControlApi(h, media);
          await until(
            async () => (await runs.observeCurrent())?.phase === "ACTIVE",
          );
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
          const createAlbum = () =>
            fetch(api!.base + "/api/v1/albums", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                familyId: h.syntheticIdentity.familyId,
                name: "synthetic-media-health-recovery",
                visibility: "FAMILY",
              }),
            });
          // Only directory identity changes: no Original file is read or modified.
          renameSync(media.path, moved);
          if (boundary === "REPLACED_ROOT") {
            const replacement = StorageRoot.open(media.path, {
              initialize: true,
            });
            replacement.close();
          }
          await until(
            async () => (await h.repository.readCurrent()).faultLatched,
          );
          expect((await h.repository.readCurrent()).enforcedMode).toBe(
            "READ_ONLY",
          );
          expect((await createAlbum()).status).toBe(503);
          await expect(h.request("NORMAL")).rejects.toMatchObject({
            reason: "CONFLICT",
          });
          const operationId = await h.beginRecheck();
          negativeOperations.push(operationId);
          await until(async () => {
            const [rows] = await db.pool.query<RowDataPacket[]>(
              "SELECT status FROM system_control_operations WHERE id=? AND actor_user_id=? AND actor_family_id=?",
              [
                operationId,
                h.syntheticIdentity.userId,
                h.syntheticIdentity.familyId,
              ],
            );
            return rows[0]?.status === "RECOVERY_REQUIRED";
          });
          expect((await createAlbum()).status).toBe(503);
          restore();
          await h.reauthenticate("synthetic-in-process-control-password");
          await h.recheck();
          expect((await h.repository.readCurrent()).enforcedMode).toBe(
            "READ_ONLY",
          );
          expect((await createAlbum()).status).toBe(503);
          await h.request("NORMAL");
          const result = await createAlbum();
          expect(result.status).toBe(201);
          albumId = (await result.json()).id;
        } finally {
          restore();
          if (api && owner) {
            try {
              await owner.fixture.reauthenticate(
                "synthetic-in-process-control-password",
              );
              const state = await owner.fixture.repository.readCurrent();
              if (state.faultLatched || state.transitionState !== "STABLE")
                await owner.fixture.recheck();
              await owner.fixture.request("READ_ONLY");
            } finally {
              await api.stop();
            }
          }
          if (albumId && owner)
            await db.pool.query(
              "DELETE FROM albums WHERE id=? AND family_id=? AND name='synthetic-media-health-recovery'",
              [albumId, owner.fixture.syntheticIdentity.familyId],
            );
          if (owner) await owner.fixture.cleanup(negativeOperations);
          await db.pool.end();
        }
      }, 120000);
  },
);
