import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  statSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSessionToken,
  hashSessionToken,
} from "../../packages/auth/src/index.js";
import {
  createDatabase,
  assertMigrationReadiness,
  MySqlMediaRepository,
  MySqlJobRepository,
  MySqlUploadPipelineRepository,
  MySqlLocationProjectionRepository,
  type LocationToken,
  CommitOutcomeUnknownError,
} from "../../packages/db/src/index.js";
import {
  StorageRoot,
  DerivedStore,
  CapacityGate,
  buildOriginalPath,
} from "../../packages/storage/src/index.js";
import { loadLocationProjector } from "../../packages/media/src/index.js";
import { PurgeProcessor } from "../../apps/worker/src/purge-processor.js";
import { UploadPipelineReconciler } from "../../apps/api/src/uploads/pipeline-reconciler.js";
import { freshStorageRootPath } from "../fixtures/fresh-storage-root.js";
import { syntheticGpsJpeg } from "../fixtures/location-jpeg.js";
import { ContentCoordination } from "../../packages/storage/src/phase7-coordination.js";

if (!process.env.DATABASE_URL)
  throw new Error("PIPELINE_DEV_DATABASE_REQUIRED");
describe.sequential(
  "Phase8 actual API upload and durable runtime pipeline",
  () => {
    const db = createDatabase(process.env.DATABASE_URL!),
      rootPath = freshStorageRootPath("p8-upload-pipeline-"),
      suffix = randomUUID().replaceAll("-", "");
    const token = createSessionToken(),
      secondToken = createSessionToken();
    const observer = new MySqlUploadPipelineRepository(db.pool),
      media = new MySqlMediaRepository(db.pool),
      jobs = new MySqlJobRepository(db.pool);
    let familyId = "",
      userId = "",
      secondUserId = "",
      marker = "",
      port = 0,
      api: ChildProcess | undefined,
      metadata: ChildProcess | undefined;
    let diagnostics = "";
    let readyForPurge:
      | {
          candidate: Parameters<UploadPipelineReconciler["reconcile"]>[0];
          mediaId: string;
          albumId: string;
        }
      | undefined;
    beforeAll(async () => {
      const c = await db.pool.getConnection();
      try {
        await c.query("SET SESSION time_zone = '+00:00'");
        const [rows] = await c.query<RowDataPacket[]>(
          "SELECT DATABASE() db,CURRENT_USER() account",
        );
        if (
          rows[0]?.db !== "family_album_dev" ||
          String(rows[0]?.account).split("@")[0]?.toLowerCase() === "root"
        )
          throw new Error("PIPELINE_DEV_PREFLIGHT_REFUSED");
        await assertMigrationReadiness(c);
        const [f] = await c.query<ResultSetHeader>(
          "INSERT INTO families(name) VALUES(?)",
          [`p8-runtime-${suffix}`],
        );
        familyId = String(f.insertId);
        const [u] = await c.query<ResultSetHeader>(
          "INSERT INTO users(username,username_normalized,password_hash,display_name,password_changed_at) VALUES(?,?,?,'Synthetic pipeline',CURRENT_TIMESTAMP(3))",
          [
            `p8pipe_${suffix}`,
            Buffer.from(`p8pipe_${suffix}`),
            "synthetic-unused",
          ],
        );
        userId = String(u.insertId);
        await c.query(
          "INSERT INTO family_members(family_id,user_id,role) VALUES(?,?,'MEMBER')",
          [familyId, userId],
        );
        await c.query(
          "INSERT INTO sessions(user_id,token_hash,client_type,authenticated_at,last_seen_at,expires_at) VALUES(?,?,'WEB',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))",
          [userId, hashSessionToken(token)],
        );
        const secondName = `p8second_${suffix}`;
        const [secondUser] = await c.query<ResultSetHeader>(
          "INSERT INTO users(username,username_normalized,password_hash,display_name,password_changed_at) VALUES(?,?,?,'Synthetic second uploader',CURRENT_TIMESTAMP(3))",
          [secondName, Buffer.from(secondName), "synthetic-unused"],
        );
        secondUserId = String(secondUser.insertId);
        await c.query(
          "INSERT INTO family_members(family_id,user_id,role) VALUES(?,?,'MEMBER')",
          [familyId, secondUserId],
        );
        await c.query(
          "INSERT INTO sessions(user_id,token_hash,client_type,authenticated_at,last_seen_at,expires_at) VALUES(?,?,'WEB',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))",
          [secondUserId, hashSessionToken(secondToken)],
        );
      } finally {
        c.release();
      }
      const root = StorageRoot.open(rootPath, { initialize: true });
      try {
        marker = root.markerId;
        mkdirSync(join(rootPath, "derived"), { mode: 0o700 });
        root.provisionDerivedWriterLockForDev();
        root.provisionSharedCapacityLockForDev();
        root.assertCoordinationNamespace();
      } finally {
        root.close();
      }
      const server = createServer();
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      port = (server.address() as { port: number }).port;
      await new Promise<void>((r) => server.close(() => r()));
    });
    function environment(enabled: boolean) {
      return {
        ...process.env,
        APP_ENV: "dev",
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        API_HOST: "127.0.0.1",
        API_PORT: String(port),
        API_PUBLIC_ORIGIN: `https://localhost:${port}`,
        TRUSTED_WEB_ORIGINS: "https://localhost:3000",
        DEV_MEDIA_ROOT: rootPath,
        DEV_STORAGE_MARKER_ID: marker,
        LOCATION_DATA_DIR: resolve("resources/location/2026-10-03"),
        DEV_MEDIA_PIPELINE_ENABLED: enabled ? "1" : "0",
      };
    }
    async function start(enabled: boolean, preload?: string) {
      diagnostics = "";
      api = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          ...(preload ? ["--import", preload] : []),
          "apps/api/dist/index.js",
        ],
        {
          env: environment(enabled),
          stdio: preload
            ? ["ignore", "ignore", "pipe", "ipc"]
            : ["ignore", "ignore", "pipe"],
        },
      );
      api.stderr!.on("data", (d) => {
        diagnostics = (diagnostics + String(d)).slice(-4096);
      });
      await until(async () => {
        if (api?.exitCode !== null) throw new Error("BUILT_API_STARTUP_FAILED");
        try {
          return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
        } catch {
          return false;
        }
      }, 15000);
    }
    async function stop(
      child: ChildProcess | undefined,
      signal: NodeJS.Signals | null = "SIGTERM",
    ) {
      if (!child || child.exitCode !== null || child.signalCode !== null)
        return;
      const done = once(child, "exit");
      if (signal) child.kill(signal);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          done,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              child.kill("SIGKILL");
              reject(new Error("PIPELINE_DRAIN_TIMEOUT"));
            }, 15000);
          }),
        ]);
        if (signal !== "SIGKILL") expect(result[0]).toBe(0);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    async function request(
      path: string,
      method = "GET",
      body?: unknown,
      actorToken = token,
    ) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          cookie: `__Host-family_session=${actorToken}`,
          origin: "https://localhost:3000",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.status).toBeLessThan(300);
      return response;
    }
    async function upload(
      bytes: Buffer,
      actorToken = token,
      beforeFinalize?: () => Promise<void>,
    ) {
      const headers = {
        cookie: `__Host-family_session=${actorToken}`,
        origin: "https://localhost:3000",
        "tus-resumable": "1.0.0",
      };
      const created = await fetch(
        `http://127.0.0.1:${port}/api/v1/families/${familyId}/uploads/tus`,
        {
          method: "POST",
          headers: {
            ...headers,
            "upload-length": String(bytes.length),
            "upload-metadata": `filename ${Buffer.from("synthetic.jpg").toString("base64")},filetype ${Buffer.from("image/jpeg").toString("base64")}`,
          },
        },
      );
      expect(created.status).toBe(201);
      const publicId = created.headers.get("location")!.split("/").at(-1)!;
      const patched = await fetch(
        `http://127.0.0.1:${port}/api/v1/uploads/tus/${publicId}`,
        {
          method: "PATCH",
          headers: {
            ...headers,
            "upload-offset": "0",
            "content-type": "application/offset+octet-stream",
          },
          body: new Uint8Array(bytes),
        },
      );
      expect(patched.status).toBe(204);
      await beforeFinalize?.();
      const completed = await request(
        `/api/v1/uploads/${publicId}/finalize`,
        "POST",
        {},
        actorToken,
      );
      expect((await completed.json()).state).toBe("COMPLETE");
      const [rows] = await db.pool.query<RowDataPacket[]>(
        "SELECT CAST(id AS CHAR) uploadId,CAST(family_id AS CHAR) familyId,CAST(storage_object_id AS CHAR) expectedStorageObjectId,LOWER(HEX(computed_sha256)) expectedSha256Hex,CAST(declared_size AS CHAR) expectedByteSize FROM upload_sessions WHERE public_id=UNHEX(?)",
        [publicId],
      );
      return {
        publicId,
        candidate: rows[0] as unknown as Parameters<
          UploadPipelineReconciler["reconcile"]
        >[0],
      };
    }
    afterAll(async () => {
      await stop(metadata);
      await stop(api);
      const c = await db.pool.getConnection();
      try {
        await c.beginTransaction();
        for (const table of [
          "audit_logs",
          "purge_files",
          "media_location_projections",
          "album_media",
          "derived_assets",
          "background_jobs",
          "media_items",
          "upload_sessions",
          "storage_objects",
          "purge_intents",
          "albums",
          "family_members",
        ])
          await c.query(`DELETE FROM ${table} WHERE family_id=?`, [familyId]);
        await c.query("DELETE FROM sessions WHERE user_id IN (?,?)", [
          userId,
          secondUserId,
        ]);
        await c.query("DELETE FROM users WHERE id IN (?,?)", [
          userId,
          secondUserId,
        ]);
        await c.query("DELETE FROM families WHERE id=?", [familyId]);
        await c.commit();
      } catch (error) {
        await c.rollback();
        throw error;
      } finally {
        c.release();
        await db.pool.end();
        rmSync(rootPath, { recursive: true, force: true });
      }
    });
    it("recovers real COMPLETE A/B windows and unknown T1, preserves dedup source, reaches native READY and ACL map through built API owner", async () => {
      await start(false);
      const bytes = syntheticGpsJpeg(),
        a = await upload(bytes);
      expect((await observer.observeUploadPipeline(a.candidate)).result).toBe(
        "MISSING_MEDIA",
      );
      const path = join(
          rootPath,
          buildOriginalPath(
            familyId,
            createHash("sha256").update(bytes).digest("hex"),
            String(bytes.length),
          ),
        ),
        before = statSync(path),
        original = readFileSync(path);
      // Crash after durable COMPLETE and before attachment: persisted receipt is authority.
      await stop(api, "SIGKILL");
      api = undefined;
      const root = StorageRoot.open(rootPath, {
        initialize: false,
        expectedMarkerId: marker,
      });
      try {
        const broken = new UploadPipelineReconciler({
          repository: observer,
          media: {
            createOrGetCanonicalMedia: async (input) => {
              await media.createOrGetCanonicalMedia(input);
              throw new CommitOutcomeUnknownError();
            },
          },
          jobs,
          acquire: UploadPipelineReconciler.acquire(root),
        });
        await expect(broken.reconcile(a.candidate)).rejects.toBeInstanceOf(
          CommitOutcomeUnknownError,
        );
        expect((await observer.observeUploadPipeline(a.candidate)).result).toBe(
          "MISSING_PROBE",
        );
      } finally {
        root.close();
      }
      // Authorized fresh process performs observation of B; no seeded media/job.
      await start(true);
      await until(
        async () =>
          (await observer.observeUploadPipeline(a.candidate)).result ===
          "PIPELINE_ATTACHED",
        10000,
      );
      const attached = await observer.observeUploadPipeline(a.candidate),
        canonical = attached.media!;
      const duplicate = await upload(bytes, secondToken);
      metadata = spawn(
        process.execPath,
        ["--import", "tsx", "apps/worker/dist/metadata-main.js"],
        { env: environment(true), stdio: ["ignore", "ignore", "pipe"] },
      );
      metadata.stderr!.on("data", (d) => {
        diagnostics = (diagnostics + String(d)).slice(-4096);
      });
      await until(async () => {
        const [r] = await db.pool.query<RowDataPacket[]>(
          "SELECT processing_state state FROM media_items WHERE family_id=? AND id=?",
          [familyId, canonical.id],
        );
        return r[0]?.state === "READY";
      }, 30000);
      const [counts] = await db.pool.query<RowDataPacket[]>(
        "SELECT (SELECT COUNT(*) FROM media_items WHERE family_id=?) media,(SELECT COUNT(*) FROM background_jobs WHERE family_id=? AND job_type='MEDIA_PROBE') probe,(SELECT COUNT(*) FROM derived_assets WHERE family_id=? AND state='READY') assets",
        [familyId, familyId, familyId],
      );
      expect(Number(counts[0]!.media)).toBe(1);
      expect(Number(counts[0]!.probe)).toBe(1);
      expect(Number(counts[0]!.assets)).toBe(2);
      const binding = await observer.observeUploadPipeline(duplicate.candidate);
      expect(binding.media!.id).toBe(canonical.id);
      expect(binding.media!.sourceUploadId).toBe(a.candidate.uploadId);
      const empty = await (
        await request(`/api/v1/families/${familyId}/search/map`)
      ).json();
      expect(empty.locatedCount).toBe(0);
      const album = await (
        await request("/api/v1/albums", "POST", {
          familyId,
          name: "Synthetic pipeline",
          visibility: "CUSTOM",
        })
      ).json();
      await request(`/api/v1/albums/${album.id}/media`, "POST", {
        mediaId: canonical.id,
      });
      const mapResponse = await request(
          `/api/v1/families/${familyId}/search/map`,
        ),
        map = await mapResponse.json();
      expect(mapResponse.headers.get("cache-control")).toBe(
        "private, no-store",
      );
      expect(map.locatedCount).toBe(1);
      const unauthorizedMap = await (
        await request(
          `/api/v1/families/${familyId}/search/map`,
          "GET",
          undefined,
          secondToken,
        )
      ).json();
      expect(unauthorizedMap.locatedCount).toBe(0);
      const gallery = await (
        await request(`/api/v1/albums/${album.id}/media`)
      ).json();
      expect(JSON.stringify(gallery)).toContain(canonical.id);
      expect(JSON.stringify(map)).not.toContain("37.780000");
      expect(JSON.stringify(gallery)).not.toContain("gpsLatitude");
      expect(readFileSync(path)).toEqual(original);
      expect(statSync(path).ino).toBe(before.ino);
      expect(
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ).toBe(a.candidate.expectedSha256Hex);
      await stop(metadata);
      metadata = undefined;
      await stop(api);
      api = undefined;
      expect(diagnostics).not.toContain("api_startup_refused");
    }, 60000);
    it("restarts the built owner directly from pure COMPLETE A and reaches READY without attachment helpers", async () => {
      await start(false);
      const bytes = syntheticGpsJpeg(36.1, -115.1),
        receipt = await upload(bytes);
      expect(
        (await observer.observeUploadPipeline(receipt.candidate)).result,
      ).toBe("MISSING_MEDIA");
      await stop(api, "SIGKILL");
      api = undefined;
      await start(true);
      metadata = spawn(
        process.execPath,
        ["--import", "tsx", "apps/worker/dist/metadata-main.js"],
        { env: environment(true), stdio: ["ignore", "ignore", "pipe"] },
      );
      await until(async () => {
        const observation = await observer.observeUploadPipeline(
          receipt.candidate,
        );
        return (
          observation.result === "PIPELINE_ATTACHED" &&
          observation.media?.processingState === "READY"
        );
      }, 30000);
      const canonical = (
        await observer.observeUploadPipeline(receipt.candidate)
      ).media!;
      const [rows] = await db.pool.query<RowDataPacket[]>(
        "SELECT (SELECT COUNT(*) FROM media_items WHERE family_id=? AND storage_object_id=?) media,(SELECT COUNT(*) FROM background_jobs WHERE family_id=? AND media_id=? AND job_type='MEDIA_PROBE') probe,(SELECT COUNT(*) FROM media_location_projections WHERE family_id=? AND media_id=?) projection",
        [
          familyId,
          receipt.candidate.expectedStorageObjectId,
          familyId,
          canonical.id,
          familyId,
          canonical.id,
        ],
      );
      expect([
        Number(rows[0]!.media),
        Number(rows[0]!.probe),
        Number(rows[0]!.projection),
      ]).toEqual([1, 1, 1]);
      const album = await (
        await request("/api/v1/albums", "POST", {
          familyId,
          name: "Pure A runtime",
          visibility: "CUSTOM",
        })
      ).json();
      await request(`/api/v1/albums/${album.id}/media`, "POST", {
        mediaId: canonical.id,
      });
      const map = await (
        await request(
          `/api/v1/families/${familyId}/search/map?albumId=${album.id}&bbox=-0.0000001,-90,180,90&zoom=1`,
        )
      ).json();
      expect(map.locatedCount).toBe(1); // locatedCount is total matching locations; bbox limits clusters only.
      expect(
        (
          await (
            await request(
              `/api/v1/families/${familyId}/search/map?albumId=${album.id}`,
            )
          ).json()
        ).locatedCount,
      ).toBe(1);
      const path = join(
        rootPath,
        buildOriginalPath(
          familyId,
          receipt.candidate.expectedSha256Hex,
          receipt.candidate.expectedByteSize,
        ),
      );
      expect(readFileSync(path)).toEqual(bytes);
      readyForPurge = {
        candidate: receipt.candidate,
        mediaId: canonical.id,
        albumId: album.id,
      };
      await stop(metadata);
      metadata = undefined;
      await stop(api);
      api = undefined;
    }, 60000);
    it("metadata SIGTERM drains the active real recovery transaction then selects no remaining recovery or claim", async () => {
      await start(false);
      const receipts = await Promise.all([
        upload(syntheticGpsJpeg(21, 31)),
        upload(syntheticGpsJpeg(22, 31)),
      ]);
      await stop(api);
      api = undefined;
      await start(true);
      await until(
        async () =>
          (
            await Promise.all(
              receipts.map((r) => observer.observeUploadPipeline(r.candidate)),
            )
          ).every((o) => o.result === "PIPELINE_ATTACHED"),
        15000,
      );
      await stop(api);
      api = undefined;
      const identity = MySqlJobRepository.createWorkerIdentity();
      const claims = [
        await jobs.claimNext(identity, { jobType: "MEDIA_PROBE" }),
        await jobs.claimNext(identity, { jobType: "MEDIA_PROBE" }),
      ];
      expect(claims.every((c) => c && c.familyId === familyId)).toBe(true);
      await db.pool.query(
        "UPDATE background_jobs SET locked_at=UTC_TIMESTAMP(3)-INTERVAL 2 MINUTE,heartbeat_at=UTC_TIMESTAMP(3)-INTERVAL 2 MINUTE,locked_until=UTC_TIMESTAMP(3)-INTERVAL 1 MINUTE WHERE family_id=? AND id IN (?,?)",
        [familyId, claims[0]!.id, claims[1]!.id],
      );
      const preload = join(rootPath, "..", "metadata-stop.mjs");
      writeFileSync(
        preload,
        `
        import {MySqlJobRepository} from ${JSON.stringify(resolve("packages/db/dist/index.js"))};
        import {OriginalReader} from ${JSON.stringify(resolve("packages/storage/src/index.ts"))};
        let first=true;const send=m=>process.send?.(m);
        const recover=MySqlJobRepository.prototype.recoverExpiredLease;
        MySqlJobRepository.prototype.recoverExpiredLease=async function(...args){send('recover-enter');const result=await recover.apply(this,args);if(first){first=false;send('recovery-paused');await new Promise(r=>{const receive=m=>{if(m==='release'){process.off('message',receive);r();}};process.on('message',receive);});send('recovery-settled');}return result;};
        const claim=MySqlJobRepository.prototype.claimNext;
        MySqlJobRepository.prototype.claimNext=function(...args){send('claim');return claim.apply(this,args);};
        const close=OriginalReader.prototype.close;
        OriginalReader.prototype.close=function(){send('reader-close');const result=close.call(this);if(process.connected)process.disconnect();return result;};
      `,
        { mode: 0o600 },
      );
      metadata = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          preload,
          "apps/worker/dist/metadata-main.js",
        ],
        { env: environment(true), stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      const events: string[] = [];
      metadata.on("message", (m) => events.push(String(m)));
      await until(async () => events.includes("recovery-paused"), 5000);
      metadata.kill("SIGTERM");
      await delay(100);
      expect(events).not.toContain("reader-close");
      expect(metadata.exitCode).toBeNull();
      metadata.send("release");
      await stop(metadata, null);
      metadata = undefined;
      expect(events).toEqual([
        "recover-enter",
        "recovery-paused",
        "recovery-settled",
        "reader-close",
      ]);
      const [rows] = await db.pool.query<RowDataPacket[]>(
        "SELECT state,attempts FROM background_jobs WHERE family_id=? AND id IN (?,?) ORDER BY id",
        [familyId, claims[0]!.id, claims[1]!.id],
      );
      expect(rows.map((r) => r.state)).toEqual(["RETRY_WAIT", "RUNNING"]);
      expect(rows.map((r) => Number(r.attempts))).toEqual([1, 1]);
      // This fixture deliberately stops selection. Settle its remaining lease
      // through the same recovery API; neither job is hand-created or reset.
      await jobs.recoverExpiredLease({
        familyId,
        mediaId: claims[1]!.mediaId,
        jobId: claims[1]!.id,
        generation: claims[1]!.generation,
      });
    }, 30000);
    it("SIGTERM drains actual native render/publication and concurrent upload admission before closing owner resources", async () => {
      for (const phase of ["render", "publication"] as const) {
        await start(false);
        const receipt = await upload(
          syntheticGpsJpeg(30 + (phase === "render" ? 0 : 1), 30),
        );
        await stop(api);
        api = undefined;
        const preload = join(rootPath, "..", `owner-${phase}.mjs`);
        // Preload instrumentation invokes every real collaborator. It only pauses
        // after native render / publishing commit / upload admission commit and
        // observes resource closure; no runtime bypass or seeded pipeline state.
        writeFileSync(
          preload,
          `
          import {OriginalReader,StorageRoot,CapacityGate,DerivedStore} from ${JSON.stringify(resolve("packages/storage/src/index.ts"))};
          import {MySqlDerivedAssetFence,MySqlUploadRepository,MySqlJobRepository} from ${JSON.stringify(resolve("packages/db/dist/index.js"))};
          const phase=${JSON.stringify(phase)}, target=${JSON.stringify(familyId)};
          const events=name=>process.send?.(name);const wait=name=>new Promise(r=>{const receive=m=>{if(m===name){process.off('message',receive);r();}};process.on('message',receive);});
          let paused=false,admission=false;
          const original=OriginalReader.prototype.withVerifiedOriginal;
          OriginalReader.prototype.withVerifiedOriginal=function(input,callback){return original.call(this,input,async handle=>{const output=await callback(handle);if(phase==='render'&&!paused&&input.familyId===target){paused=true;events('render-paused');await wait('release-work');events('work-settled');}return output;});};
          const publishing=MySqlDerivedAssetFence.prototype.markPublishing;
          MySqlDerivedAssetFence.prototype.markPublishing=async function(...args){const result=await publishing.apply(this,args);if(phase==='publication'&&!paused){paused=true;events('publication-paused');await wait('release-work');events('work-settled');}return result;};
          const create=MySqlUploadRepository.prototype.createUploadCapacityAdmitted;
          MySqlUploadRepository.prototype.createUploadCapacityAdmitted=async function(...args){const result=await create.apply(this,args);if(!admission){admission=true;events('admission-paused');await wait('release-admission');events('admission-settled');}return result;};
          const claim=MySqlJobRepository.prototype.claimNext;
          MySqlJobRepository.prototype.claimNext=async function(...args){events('claim');return claim.apply(this,args);};
          for(const [name,klass] of [['store',DerivedStore],['reader',OriginalReader],['gate',CapacityGate],['root',StorageRoot]]){const close=klass.prototype.close;klass.prototype.close=function(){events('close-'+name);const result=close.call(this);if(name==='root'&&process.connected)process.disconnect();return result;};}
          for(const method of ['describe','adoptReserved','markPublishing','confirmPublishing','commitSucceeded','commitAttempt']){const operation=MySqlDerivedAssetFence.prototype[method];MySqlDerivedAssetFence.prototype[method]=async function(...args){events('enter-'+method);try{const result=await operation.apply(this,args);events('done-'+method);return result;}catch(e){events('failed-'+method);throw e;}};}
          const admit=CapacityGate.prototype.withAdmissionLock;
          CapacityGate.prototype.withAdmissionLock=async function(...args){events('gate-enter');try{const result=await admit.apply(this,args);events('gate-done');return result;}catch(e){events('gate-failed');throw e;}};
          process.on('SIGTERM',()=>events('stop-signal'));
          events('preload-ready');
        `,
          { mode: 0o600 },
        );
        await start(true, preload);
        const events: string[] = [];
        api!.on("message", (m) => {
          events.push(String(m));
          writeFileSync(
            `.cache/phase8-map/evidence/closure-owner-${phase}.json`,
            JSON.stringify(events),
          );
        });
        metadata = spawn(
          process.execPath,
          ["--import", "tsx", "apps/worker/dist/metadata-main.js"],
          { env: environment(true), stdio: ["ignore", "ignore", "pipe"] },
        );
        await until(async () => events.includes(`${phase}-paused`), 15000);
        // A separate real HTTP request competes for the SAME owner admission gate.
        const admission = fetch(
          `http://127.0.0.1:${port}/api/v1/families/${familyId}/uploads/tus`,
          {
            method: "POST",
            headers: {
              cookie: `__Host-family_session=${token}`,
              origin: "https://localhost:3000",
              "tus-resumable": "1.0.0",
              "upload-length": "100",
              "upload-metadata": `filename ${Buffer.from("drain.jpg").toString("base64")},filetype ${Buffer.from("image/jpeg").toString("base64")}`,
            },
          },
        );
        await until(async () => events.includes("admission-paused"), 5000);
        const claims = events.filter((e) => e === "claim").length;
        api!.kill("SIGTERM");
        await delay(100);
        expect(api!.exitCode).toBeNull();
        expect(events.some((e) => e.startsWith("close-"))).toBe(false);
        api!.send("release-admission");
        expect((await admission).status).toBe(201);
        expect(events.some((e) => e.startsWith("close-"))).toBe(false);
        api!.send("release-work");
        const admitted = await admission;
        expect(admitted.status).toBe(201);
        await admitted.arrayBuffer();
        await stop(api, null);
        api = undefined;
        expect(events.filter((e) => e === "claim")).toHaveLength(claims);
        expect(events.filter((e) => e.startsWith("close-"))).toEqual([
          "close-store",
          "close-reader",
          "close-gate",
          "close-root",
        ]);
        expect(events.indexOf("admission-settled")).toBeLessThan(
          events.indexOf("close-store"),
        );
        expect(events.indexOf("work-settled")).toBeLessThan(
          events.indexOf("close-store"),
        );
        expect(
          (await observer.observeUploadPipeline(receipt.candidate)).media!
            .processingState,
        ).toBe("READY");
        await stop(metadata);
        metadata = undefined;
      }
    }, 60000);
    it("real COMPLETE discovery spans three pages, advances past a deferred low key, and catches late low and new high receipts next round", async () => {
      await start(false);
      let releaseLate!: () => void, lateStaged!: () => void;
      const staged = new Promise<void>((r) => {
          lateStaged = r;
        }),
        release = new Promise<void>((r) => {
          releaseLate = r;
        });
      const latePromise = upload(syntheticGpsJpeg(10, 10), token, async () => {
        lateStaged();
        await release;
      });
      await staged;
      const receipts = [];
      for (let n = 0; n < 41; n++) {
        // Each owner keeps the unmodified runtime upload rate limiter. Explicit
        // disabled-owner restarts keep fixture batches below its burst budget.
        if (n > 0 && n % 6 === 0) {
          await stop(api);
          api = undefined;
          await start(false);
        }
        receipts.push(await upload(syntheticGpsJpeg(11 + n / 10, 20)));
      }
      const first = receipts[0]!.candidate;
      const high = await observer.readUploadPipelineHighWater();
      const pages: string[][] = [],
        waits: number[] = [];
      let finished = 0,
        deferred = true;
      const worker = new UploadPipelineReconciler(
        {
          repository: {
            readUploadPipelineHighWater: async () =>
              finished === 0 ? high : observer.readUploadPipelineHighWater(),
            listUploadPipelinePage: async (input) => {
              // Actual SQL keyset pages, bounded to this isolated fixture range.
              const rows = await observer.listUploadPipelinePage({
                ...input,
                afterId:
                  BigInt(input.afterId) < BigInt(first.uploadId) - 2n
                    ? String(BigInt(first.uploadId) - 2n)
                    : input.afterId,
              });
              expect(rows.every((r) => r.familyId === familyId)).toBe(true);
              pages.push(rows.map((r) => r.uploadId));
              return rows;
            },
            observeUploadPipeline:
              observer.observeUploadPipeline.bind(observer),
          },
          media,
          jobs,
          // SQL fairness seam only; native L contention is covered separately.
          acquire: async (c) => {
            if (deferred && c.uploadId === first.uploadId)
              throw new Error("COORD_ACQUIRE_TIMEOUT");
            return { close() {} };
          },
        },
        () => {
          finished++;
        },
        async (ms) => {
          waits.push(ms);
        },
      );
      await worker.page();
      releaseLate();
      const late = await latePromise;
      const higher = await upload(syntheticGpsJpeg(17, 21));
      await worker.page();
      await worker.page();
      await worker.page();
      expect(pages.slice(0, 3).map((p) => p.length)).toEqual([20, 20, 1]);
      expect(waits).toEqual([250, 250, 250, 30000]);
      expect(
        (await observer.observeUploadPipeline(receipts[40]!.candidate)).result,
      ).toBe("PIPELINE_ATTACHED");
      expect((await observer.observeUploadPipeline(first)).result).toBe(
        "MISSING_MEDIA",
      );
      expect(
        (await observer.observeUploadPipeline(higher.candidate)).result,
      ).toBe("MISSING_MEDIA");
      deferred = false;
      // The SAME scheduler resets its keyset cursor and reads the new real
      // high-water; the late low receipt is naturally eligible next round.
      for (let n = 0; n < 4; n++) await worker.page();
      for (const receipt of [late, higher, receipts[0]!])
        expect(
          (await observer.observeUploadPipeline(receipt.candidate)).result,
        ).toBe("PIPELINE_ATTACHED");
      await stop(api);
      api = undefined;
    }, 60000);
    it("races two real same-K receipts under native shared guards and keeps one canonical source and probe", async () => {
      await start(false);
      const bytes = syntheticGpsJpeg(25, 25),
        receipts = await Promise.all([
          upload(bytes),
          upload(bytes, secondToken),
        ]);
      await stop(api);
      api = undefined;
      const root = StorageRoot.open(rootPath, {
        initialize: false,
        expectedMarkerId: marker,
      });
      try {
        let arrivals = 0,
          release!: () => void;
        const both = new Promise<void>((r) => {
          release = r;
        });
        const sharedObserver = {
          readUploadPipelineHighWater:
            observer.readUploadPipelineHighWater.bind(observer),
          listUploadPipelinePage:
            observer.listUploadPipelinePage.bind(observer),
          observeUploadPipeline: async (
            c: (typeof receipts)[number]["candidate"],
          ) => {
            const observation = await observer.observeUploadPipeline(c);
            if (observation.result === "MISSING_MEDIA") {
              if (++arrivals === 2) release();
              await both;
            }
            return observation;
          },
        };
        const workers = receipts.map(
          () =>
            new UploadPipelineReconciler({
              repository: sharedObserver,
              media,
              jobs,
              acquire: UploadPipelineReconciler.acquire(root),
            }),
        );
        const outcomes = await Promise.all(
          workers.map((w, n) => w.reconcile(receipts[n]!.candidate)),
        );
        expect(
          outcomes.every(
            (o) => o.result === "PIPELINE_ATTACHED" || o.result === "DEFERRED",
          ),
        ).toBe(true);
        const observed = await Promise.all(
          receipts.map((r) => observer.observeUploadPipeline(r.candidate)),
        );
        expect(observed.every((o) => o.result === "PIPELINE_ATTACHED")).toBe(
          true,
        );
        const winner = observed[0]!.media!;
        expect(observed[1]!.media!.id).toBe(winner.id);
        expect(receipts.map((r) => r.candidate.uploadId)).toContain(
          winner.sourceUploadId,
        );
        for (const r of receipts)
          expect(
            (
              await new UploadPipelineReconciler({
                repository: observer,
                media,
                jobs,
                acquire: UploadPipelineReconciler.acquire(root),
              }).reconcile(r.candidate)
            ).result,
          ).toBe("PIPELINE_ATTACHED");
        const [rows] = await db.pool.query<RowDataPacket[]>(
          "SELECT CAST(source_upload_id AS CHAR) source,uploaded_at uploadedAt,(SELECT COUNT(*) FROM background_jobs WHERE family_id=? AND media_id=m.id AND job_type='MEDIA_PROBE') probe FROM media_items m WHERE family_id=? AND storage_object_id=?",
          [familyId, familyId, receipts[0]!.candidate.expectedStorageObjectId],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.source).toBe(winner.sourceUploadId);
        expect(Number(rows[0]!.probe)).toBe(1);
      } finally {
        root.close();
      }
    }, 30000);
    it("resolves committed and rolled-back unknown T1/T2 from fresh locking observations", async () => {
      await start(false);
      const receipts = [
        await upload(syntheticGpsJpeg(40.7, -74)),
        await upload(syntheticGpsJpeg(48.85, 2.35)),
        await upload(syntheticGpsJpeg(35.68, 139.69)),
        await upload(syntheticGpsJpeg(-33.86, 151.2)),
      ];
      await stop(api);
      api = undefined;
      const root = StorageRoot.open(rootPath, {
        initialize: false,
        expectedMarkerId: marker,
      });
      try {
        for (const [n, receipt] of receipts.entries()) {
          const step = n < 2 ? "T1" : "T2";
          if (step === "T2")
            await media.createOrGetCanonicalMedia({
              familyId,
              uploadId: receipt.candidate.uploadId,
            });
          const committed = n % 2 === 0;
          const faultPool = new Proxy(db.pool, {
            get(target, key) {
              if (key === "getConnection")
                return async () => {
                  const c = await target.getConnection();
                  return new Proxy(c, {
                    get(connection, method) {
                      if (method === "commit")
                        return async () => {
                          if (committed) await connection.commit();
                          else await connection.rollback();
                          throw new Error("SYNTHETIC_COMMIT_RESPONSE_LOST");
                        };
                      const value = Reflect.get(connection, method);
                      return typeof value === "function"
                        ? value.bind(connection)
                        : value;
                    },
                  });
                };
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          const worker = new UploadPipelineReconciler({
            repository: observer,
            media: step === "T1" ? new MySqlMediaRepository(faultPool) : media,
            jobs: step === "T2" ? new MySqlJobRepository(faultPool) : jobs,
            acquire: UploadPipelineReconciler.acquire(root),
          });
          await expect(
            worker.reconcile(receipt.candidate),
          ).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
          await expect(worker.reconcile(receipt.candidate)).rejects.toThrow(
            "PIPELINE_STOPPED_RESTART_REQUIRED",
          );
          expect(
            (await observer.observeUploadPipeline(receipt.candidate)).result,
          ).toBe(
            step === "T1"
              ? committed
                ? "MISSING_PROBE"
                : "MISSING_MEDIA"
              : committed
                ? "PIPELINE_ATTACHED"
                : "MISSING_PROBE",
          );
          const fresh = new UploadPipelineReconciler({
            repository: observer,
            media,
            jobs,
            acquire: UploadPipelineReconciler.acquire(root),
          });
          expect((await fresh.reconcile(receipt.candidate)).result).toBe(
            "PIPELINE_ATTACHED",
          );
          const observed = await observer.observeUploadPipeline(
            receipt.candidate,
          );
          const [count] = await db.pool.query<RowDataPacket[]>(
            "SELECT COUNT(*) n,MAX(attempts) attempts FROM background_jobs WHERE family_id=? AND media_id=? AND job_type='MEDIA_PROBE'",
            [familyId, observed.media!.id],
          );
          expect(Number(count[0]!.n)).toBe(1);
          expect(Number(count[0]!.attempts)).toBe(0);
        }
      } finally {
        root.close();
      }
    }, 30000);
    it("holds native L-S through both transactions while lifecycle L-X waits, and defers bounded contention", async () => {
      await start(false);
      const receipt = await upload(syntheticGpsJpeg(52.52, 13.4));
      await stop(api);
      api = undefined;
      const root = StorageRoot.open(rootPath, {
        initialize: false,
        expectedMarkerId: marker,
      });
      try {
        const k = receipt.candidate;
        const coordination = new ContentCoordination(root, {
          familyId: k.familyId,
          sha256Hex: k.expectedSha256Hex,
          byteSize: k.expectedByteSize,
        });
        const exclusive = await coordination.acquireLifecycle("X", 0);
        try {
          const contended = new UploadPipelineReconciler({
            repository: observer,
            media,
            jobs,
            acquire: () => coordination.acquireLifecycle("S", 0),
          });
          expect((await contended.reconcile(k)).result).toBe("DEFERRED");
          expect((await observer.observeUploadPipeline(k)).result).toBe(
            "MISSING_MEDIA",
          );
        } finally {
          exclusive.close();
        }
        let acquired = false;
        let waiting:
          ReturnType<ContentCoordination["acquireLifecycle"]> | undefined;
        const protectedMedia = {
          createOrGetCanonicalMedia: async (
            input: Parameters<
              MySqlMediaRepository["createOrGetCanonicalMedia"]
            >[0],
          ) => {
            const created = await media.createOrGetCanonicalMedia(input);
            waiting = coordination
              .acquireLifecycle("X", 10000)
              .then((guard) => {
                acquired = true;
                return guard;
              });
            return created;
          },
        };
        const protectedJobs = {
          enqueue: async (
            input: Parameters<MySqlJobRepository["enqueue"]>[0],
          ) => {
            expect(acquired).toBe(false);
            await expect(coordination.acquireLifecycle("X", 0)).rejects.toThrow(
              "COORD_ACQUIRE_TIMEOUT",
            );
            return jobs.enqueue(input);
          },
        };
        const worker = new UploadPipelineReconciler({
          repository: observer,
          media: protectedMedia,
          jobs: protectedJobs,
          acquire: UploadPipelineReconciler.acquire(root),
        });
        expect((await worker.reconcile(k)).result).toBe("PIPELINE_ATTACHED");
        const guard = await waiting!;
        expect(acquired).toBe(true);
        guard.close();
      } finally {
        root.close();
      }
    }, 30000);
    it("preserves inactive and terminal media and repairs a restored unstarted generation", async () => {
      await start(false);
      const receipt = await upload(syntheticGpsJpeg(51.5, -0.12));
      await stop(api);
      api = undefined;
      const root = StorageRoot.open(rootPath, {
        initialize: false,
        expectedMarkerId: marker,
      });
      try {
        const created = await media.createOrGetCanonicalMedia({
            familyId,
            uploadId: receipt.candidate.uploadId,
          }),
          m = created.media;
        const worker = new UploadPipelineReconciler({
          repository: observer,
          media,
          jobs,
          acquire: UploadPipelineReconciler.acquire(root),
        });
        expect(
          (
            await observer.observeUploadPipeline({
              ...receipt.candidate,
              expectedSha256Hex: "b".repeat(64),
            })
          ).result,
        ).toBe("STALE");
        await db.pool.query(
          "UPDATE media_items SET trashed_at=UTC_TIMESTAMP(3),trashed_by_member_id=(SELECT id FROM family_members WHERE family_id=? AND user_id=?),purge_after=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 30 DAY),lifecycle_revision=lifecycle_revision+1 WHERE id=?",
          [familyId, userId, m.id],
        );
        expect((await worker.reconcile(receipt.candidate)).result).toBe(
          "LIFECYCLE_INACTIVE",
        );
        const [none] = await db.pool.query<RowDataPacket[]>(
          "SELECT COUNT(*) n FROM background_jobs WHERE family_id=? AND media_id=?",
          [familyId, m.id],
        );
        expect(Number(none[0]!.n)).toBe(0);
        await db.pool.query(
          "UPDATE media_items SET trashed_at=NULL,trashed_by_member_id=NULL,purge_after=NULL,lifecycle_revision=lifecycle_revision+1,recipe_id=2 WHERE id=?",
          [m.id],
        );
        expect((await worker.reconcile(receipt.candidate)).result).toBe(
          "INVARIANT_REJECTED",
        );
        await db.pool.query(
          "UPDATE media_items SET recipe_id=1,generation=2 WHERE id=?",
          [m.id],
        );
        expect((await worker.reconcile(receipt.candidate)).result).toBe(
          "PIPELINE_ATTACHED",
        );
        const [current] = await db.pool.query<RowDataPacket[]>(
          "SELECT CAST(generation AS CHAR) generation,attempts FROM background_jobs WHERE family_id=? AND media_id=?",
          [familyId, m.id],
        );
        expect(current[0]!.generation).toBe("2");
        expect(current[0]!.attempts).toBe(0);
        await db.pool.query(
          "UPDATE background_jobs SET state='FAILED',last_failure_code='MALFORMED_MEDIA',finished_at=UTC_TIMESTAMP(3) WHERE family_id=? AND media_id=?",
          [familyId, m.id],
        );
        expect((await worker.reconcile(receipt.candidate)).result).toBe(
          "PIPELINE_TERMINAL_FAILED",
        );
      } finally {
        root.close();
      }
    }, 30000);
    it("purges a real runtime READY item with projection and excludes a concurrent reconciler through retirement", async () => {
      expect(readyForPurge).toBeDefined();
      const fixture = readyForPurge!;
      const [tokens] = await db.pool.query<RowDataPacket[]>(
        "SELECT CAST(family_id AS CHAR) familyId,CAST(id AS CHAR) mediaId,CAST(storage_object_id AS CHAR) storageObjectId,CAST(generation AS CHAR) generation,CAST(metadata_generation AS CHAR) metadataGeneration,recipe_id recipeId,CAST(lifecycle_revision AS CHAR) lifecycleRevision,gps_latitude gpsLatitude,gps_longitude gpsLongitude FROM media_items WHERE family_id=? AND id=?",
        [familyId, fixture.mediaId],
      );
      const tokenBeforePurge = tokens[0] as LocationToken;
      const backfill = new MySqlLocationProjectionRepository(
        db.pool,
        loadLocationProjector(resolve("resources/location/2026-10-03")),
      );

      await start(false);
      await db.pool.query(
        "UPDATE family_members SET role='ADMIN' WHERE family_id=? AND user_id=?",
        [familyId, userId],
      );
      const trashed = await (
        await request(
          `/api/v1/families/${familyId}/media/${fixture.mediaId}/trash`,
          "POST",
          {
            selectedAlbumId: fixture.albumId,
            expectedLifecycleRevision: "1",
            operationId: randomUUID(),
          },
        )
      ).json();
      // Controlled fixture clock: use the existing retention/request path, never seed an intent.
      await db.pool.query(
        "UPDATE media_items SET trashed_at=UTC_TIMESTAMP(3)-INTERVAL 31 DAY,purge_after=UTC_TIMESTAMP(3)-INTERVAL 1 DAY WHERE family_id=? AND id=?",
        [familyId, fixture.mediaId],
      );
      const operationId = randomUUID();
      await request(
        `/api/v1/families/${familyId}/trash/${fixture.mediaId}/permanent-delete`,
        "POST",
        { expectedLifecycleRevision: trashed.lifecycleRevision, operationId },
      );
      await db.pool.query(
        "UPDATE family_members SET role='MEMBER' WHERE family_id=? AND user_id=?",
        [familyId, userId],
      );
      await stop(api);
      api = undefined;
      const root = StorageRoot.open(rootPath, {
        initialize: false,
        expectedMarkerId: marker,
      });
      const store = DerivedStore.open({ state: "READ_WRITE", root }),
        gate = CapacityGate.open({
          mediaRoot: rootPath,
          expectedMarkerId: marker,
        });
      try {
        const [projections] = await db.pool.query<RowDataPacket[]>(
          "SELECT COUNT(*) n FROM media_location_projections WHERE family_id=? AND media_id=?",
          [familyId, fixture.mediaId],
        );
        expect(Number(projections[0]!.n)).toBe(1);
        let entered!: () => void, release!: () => void;
        const inside = new Promise<void>((r) => {
            entered = r;
          }),
          resume = new Promise<void>((r) => {
            release = r;
          });
        const purge = new PurgeProcessor(db.pool, root, store, gate, {
          commit: async (name, c) => {
            if (name === "DETACH") {
              entered();
              await resume;
            }
            await c.commit();
          },
        });
        const lease = await purge.repository.claim();
        expect(lease).not.toBeNull();
        const running = purge.run(lease!);
        await inside;
        const k = fixture.candidate,
          coord = new ContentCoordination(root, {
            familyId,
            sha256Hex: k.expectedSha256Hex,
            byteSize: k.expectedByteSize,
          });
        const reconciler = new UploadPipelineReconciler({
          repository: observer,
          media,
          jobs,
          acquire: () => coord.acquireLifecycle("S", 0),
        });
        let backfillSettled = false;
        const waitingBackfill = backfill
          .apply(tokenBeforePurge)
          .then((result) => {
            backfillSettled = true;
            return result;
          });
        try {
          expect((await reconciler.reconcile(k)).result).toBe("DEFERRED");
          await delay(50);
          expect(backfillSettled).toBe(false);
        } finally {
          release();
        }
        expect(await running).toBe("COMPLETED");
        expect(await waitingBackfill).toBe("STALE");
        expect((await reconciler.reconcile(k)).result).toBe("NOT_APPLICABLE");
        const [rows] = await db.pool.query<RowDataPacket[]>(
          "SELECT state,CAST(retired_purge_id AS CHAR) retired,storage_object_id object FROM upload_sessions WHERE id=?",
          [k.uploadId],
        );
        expect(rows[0]!.state).toBe("RETIRED");
        expect(rows[0]!.retired).toBe(lease!.id);
        expect(rows[0]!.object).toBeNull();
        for (const table of [
          "media_location_projections",
          "media_items",
          "background_jobs",
          "derived_assets",
        ]) {
          const [count] = await db.pool.query<RowDataPacket[]>(
            `SELECT COUNT(*) n FROM ${table} WHERE family_id=? AND ${table === "media_items" ? "id" : "media_id"}=?`,
            [familyId, fixture.mediaId],
          );
          expect(Number(count[0]!.n)).toBe(0);
        }
        const [audit] = await db.pool.query<RowDataPacket[]>(
          "SELECT action FROM audit_logs WHERE family_id=? AND purge_intent_id=? ORDER BY id",
          [familyId, lease!.id],
        );
        expect(audit.map((r) => r.action)).toContain("PURGE_COMPLETED");
        expect(
          await observer.listUploadPipelinePage({
            afterId: String(BigInt(k.uploadId) - 1n),
            throughId: k.uploadId,
            limit: 20,
          }),
        ).toHaveLength(0);
      } finally {
        store.close();
        gate.close();
        root.close();
      }
    }, 30000);
    it("enabled startup refuses separate writer and missing namespace before claims, and listen failure releases handles", async () => {
      const [before] = await db.pool.query<RowDataPacket[]>(
        "SELECT SUM(attempts) attempts FROM background_jobs WHERE family_id=?",
        [familyId],
      );
      const root = StorageRoot.open(rootPath, {
        initialize: false,
        expectedMarkerId: marker,
      });
      try {
        await expect(start(true)).rejects.toThrow("BUILT_API_STARTUP_FAILED");
      } finally {
        root.close();
        api = undefined;
      }
      const [after] = await db.pool.query<RowDataPacket[]>(
        "SELECT SUM(attempts) attempts FROM background_jobs WHERE family_id=?",
        [familyId],
      );
      expect(after[0]!.attempts).toBe(before[0]!.attempts);
      const server = createServer((socket) => socket.destroy());
      await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
      try {
        await expect(start(true)).rejects.toThrow("BUILT_API_STARTUP_FAILED");
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
        api = undefined;
      }
      const reopened = StorageRoot.open(rootPath, {
        initialize: false,
        expectedMarkerId: marker,
      });
      reopened.close();
      // Only this task's disposable synthetic namespace is removed.
      rmSync(join(rootPath, ".coord"), { recursive: true, force: true });
      await expect(start(true)).rejects.toThrow("BUILT_API_STARTUP_FAILED");
      api = undefined;
    }, 30000);
  },
);
async function until(check: () => Promise<boolean>, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error("PIPELINE_ACCEPTANCE_TIMEOUT");
}
