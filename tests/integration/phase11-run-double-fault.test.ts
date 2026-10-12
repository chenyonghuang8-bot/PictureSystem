import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  createDatabase,
  MySqlSystemRunRepository,
} from "../../packages/db/src/index.js";
import { DevControlHarness } from "../helpers/dev-control-harness.js";
import { restartBuiltControlApi } from "../helpers/restart-built-control-api.js";
if (!process.env.DATABASE_URL) throw Error("PHASE11_DEV_DB_REQUIRED");
describe.sequential(
  "R1 native+real TCP double failure survives actual process exit",
  () => {
    for (const boundary of ["FILE_FSYNC", "TEMP_CREATE"])
      it(
        boundary +
          " cannot authorize a new built API from old NORMAL with no deny",
        async () => {
          const folder = mkdtempSync(
              join(realpathSync(tmpdir()), "phase11-r1-double-"),
            ),
            file = join(folder, "proof.json");
          const child = spawnSync(
            process.execPath,
            [
              "--import",
              "tsx",
              resolve("tests/integration/fixtures/phase11-run-double-fault.ts"),
              boundary,
              file,
            ],
            { env: process.env, stdio: "ignore", timeout: 40000 },
          );
          expect(child.status).toBe(0);
          const proof = JSON.parse(readFileSync(file, "utf8")),
            db = createDatabase(process.env.DATABASE_URL!);
          let h: DevControlHarness | undefined,
            api: Awaited<ReturnType<typeof restartBuiltControlApi>> | undefined,
            albumId: string | undefined;
          try {
            h = await DevControlHarness.resume(db.pool, proof.deploymentId);
            expect((await h.repository.readCurrent()).enforcedMode).toBe(
              "NORMAL",
            );
            expect(
              (await new MySqlSystemRunRepository(db.pool).observeCurrent())
                ?.phase,
            ).toBe("ACTIVE");
            const s = await h.gate.acquire("S", 0);
            try {
              expect(s.readDeny()).toBeNull();
            } finally {
              s.close();
            }
            api = await restartBuiltControlApi(h, proof.media);
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
                  familyId: h!.syntheticIdentity.familyId,
                  name: "synthetic-r1-double-" + boundary,
                  visibility: "FAMILY",
                }),
              });
            expect((await write()).status).toBe(503);
            await h.recheck();
            expect((await h.repository.readCurrent()).enforcedMode).toBe(
              "READ_ONLY",
            );
            expect((await write()).status).toBe(503);
            await h.request("NORMAL");
            const result = await write();
            expect(result.status).toBe(201);
            albumId = (await result.json()).id;
          } finally {
            if (api && h) {
              try {
                await h.request("READ_ONLY");
              } finally {
                await api.stop();
                api = undefined;
              }
            }
            if (albumId && h)
              await db.pool.query(
                "DELETE FROM albums WHERE id=? AND family_id=? AND name=?",
                [
                  albumId,
                  h.syntheticIdentity.familyId,
                  "synthetic-r1-double-" + boundary,
                ],
              );
            if (h) await h.cleanup();
            await db.pool.end();
            if (h) rmSync(proof.media.path, { recursive: true, force: true });
            rmSync(folder, { recursive: true, force: true });
          }
        },
        90000,
      );
  },
);
