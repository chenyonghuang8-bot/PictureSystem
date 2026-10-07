import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  createServer as createFaultServer,
  request as forwardRequest,
} from "node:http";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  RowDataPacket,
  ResultSetHeader,
  Pool,
} from "../../packages/db/src/index.js";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  createDatabase,
  assertMigrationReadiness,
  MySqlUploadRepository,
  MySqlAuthRepository,
  CommitOutcomeUnknownError,
} from "../../packages/db/src/index.js";
import {
  createPasswordEngine,
  hashSessionToken,
  createSessionToken,
} from "../../packages/auth/src/index.js";
import {
  StorageRoot,
  DerivedStore,
  CapacityGate,
  buildOriginalPath,
  buildUploadPayloadPath,
} from "../../packages/storage/src/index.js";
import { PurgeProcessor } from "../../apps/worker/src/purge-processor.js";
import { ContentCoordination } from "../../packages/storage/src/phase7-coordination.js";
import { freshStorageRootPath } from "../fixtures/fresh-storage-root.js";
import { syntheticGpsJpeg } from "../fixtures/location-jpeg.js";
if (!process.env.DATABASE_URL) throw Error("PHASE10_DEV_DB_REQUIRED");
describe.sequential("Phase10 real HTTP/MySQL common server", () => {
  const db = createDatabase(process.env.DATABASE_URL!),
    rootPath = freshStorageRootPath("p10-server-"),
    suffix = randomUUID().replaceAll("-", "");
  const uploads = new MySqlUploadRepository(db.pool),
    authRepo = new MySqlAuthRepository(db.pool);
  let app: ChildProcess | undefined,
    worker: ChildProcess | undefined,
    base = "",
    marker = "",
    familyId = "",
    userId = "",
    sessionId = "",
    token = "",
    webToken = "",
    otherToken = "",
    otherUserId = "",
    albumA = "",
    albumB = "",
    uploadId = "",
    mediaId = "",
    duplicateReceiptId = "",
    otherAlbumId = "",
    passwordHash = "";
  const operationId = randomUUID(),
    bytes = syntheticGpsJpeg();
  const extraUsers: string[] = [];
  const username = `p10_${suffix}`;
  async function until(test: () => Promise<boolean>, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await test()) return;
      await delay(100);
    }
    throw Error("PHASE10_BOUNDED_WAIT_EXPIRED");
  }
  const env = (): NodeJS.ProcessEnv => ({
    ...process.env,
    APP_ENV: "dev",
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    API_HOST: "127.0.0.1",
    API_PORT: base.split(":").at(-1)!,
    API_PUBLIC_ORIGIN: base.replace("http:", "https:"),
    TRUSTED_WEB_ORIGINS: "https://localhost:3000",
    DEV_MEDIA_ROOT: rootPath,
    DEV_STORAGE_MARKER_ID: marker,
    LOCATION_DATA_DIR: resolve("resources/location/2026-10-03"),
    DEV_MEDIA_PIPELINE_ENABLED: "1",
  });
  async function start() {
    app = spawn(
      process.execPath,
      ["--import", "tsx", "apps/api/dist/index.js"],
      { env: env(), stdio: "ignore" },
    );
    await until(async () => {
      if (app?.exitCode !== null) throw Error("PHASE10_API_EXITED");
      try {
        return (await fetch(base + "/health")).ok;
      } catch {
        return false;
      }
    }, 15000);
  }
  async function stop(
    child: ChildProcess | undefined,
    signal: NodeJS.Signals = "SIGTERM",
  ) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, "exit");
    child.kill(signal);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(Error("PHASE10_CHILD_DRAIN_TIMEOUT"));
          }, 15000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  async function req(
    path: string,
    method = "GET",
    body?: unknown,
    credential = token,
    extra: Record<string, string> = {},
  ) {
    return fetch(base + path, {
      method,
      headers: {
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function create(
    op = operationId,
    targets = [albumA, albumB],
    name = "synthetic.jpg",
    actorToken = token,
  ) {
    return req(
      `/api/v1/families/${familyId}/uploads/tus`,
      "POST",
      undefined,
      actorToken,
      {
        "tus-resumable": "1.0.0",
        "upload-length": String(bytes.length),
        "upload-client-id": op,
        "upload-target-albums": targets.join(","),
        "upload-metadata": `filename ${Buffer.from(name).toString("base64")},filetype ${Buffer.from("image/jpeg").toString("base64")}`,
      },
    );
  }
  // Real downstream response loss: forward the full request, consume the
  // successful upstream response, then close the client socket without sending
  // any response headers/body. This is not database COMMIT fault injection.
  async function loseResponse(
    path: string,
    method: string,
    headers: Record<string, string>,
    body?: Uint8Array | string,
  ) {
    let resolveWitness!: (status: number) => void;
    let rejectWitness!: (error: Error) => void;
    const witness = new Promise<number>((resolve, reject) => {
      resolveWitness = resolve;
      rejectWitness = reject;
    });
    const proxy = createFaultServer((incoming, outgoing) => {
      const upstream = forwardRequest(
        base + path,
        { method, headers },
        (response) => {
          response.resume();
          response.on("error", rejectWitness);
          response.on("end", () => {
            resolveWitness(response.statusCode!);
            outgoing.socket!.destroy();
          });
        },
      );
      upstream.on("error", (error) => {
        rejectWitness(error);
        outgoing.socket!.destroy();
      });
      incoming.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const timeout = setTimeout(() => {
      rejectWitness(Error("PHASE10_RESPONSE_LOSS_TIMEOUT"));
      proxy.closeAllConnections();
    }, 15000);
    try {
      const address = proxy.address() as { port: number };
      const [client, server] = await Promise.allSettled([
        fetch(`http://127.0.0.1:${address.port}${path}`, {
          method,
          headers,
          ...(body !== undefined
            ? { body: typeof body === "string" ? body : new Uint8Array(body) }
            : {}),
          signal: AbortSignal.timeout(15000),
        }),
        witness,
      ]);
      expect(client.status).toBe("rejected");
      if (server.status === "rejected") throw server.reason;
      return server.value;
    } finally {
      clearTimeout(timeout);
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
  async function result(id = uploadId, actorToken = token) {
    const response = await req(
      `/api/v1/uploads/${id}/result`,
      "GET",
      undefined,
      actorToken,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    return response.json();
  }
  beforeAll(async () => {
    const c = await db.pool.getConnection();
    try {
      await c.query("SET SESSION time_zone='+00:00'");
      const [identity] = await c.query<RowDataPacket[]>(
        "SELECT DATABASE() db,CURRENT_USER() account",
      );
      expect(identity[0]?.db).toBe("family_album_dev");
      expect(String(identity[0]?.account).split("@")[0]).not.toBe("root");
      await assertMigrationReadiness(c);
      passwordHash = await createPasswordEngine().hash("synthetic-password");
      const [f] = await c.query<ResultSetHeader>(
        "INSERT INTO families(name) VALUES(?)",
        [`p10_${suffix}`],
      );
      familyId = String(f.insertId);
      for (const [name, role] of [
        [username, "SUPER_ADMIN"],
        [`p10_other_${suffix}`, "MEMBER"],
      ]) {
        const [u] = await c.query<ResultSetHeader>(
          "INSERT INTO users(username,username_normalized,password_hash,password_changed_at) VALUES(?,?,?,CURRENT_TIMESTAMP(3))",
          [name, Buffer.from(name!), passwordHash],
        );
        await c.query<ResultSetHeader>(
          "INSERT INTO family_members(family_id,user_id,role) VALUES(?,?,?)",
          [familyId, String(u.insertId), role],
        );
        if (name === username) {
          userId = String(u.insertId);
        } else otherUserId = String(u.insertId);
      }
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
    const { createServer } = await import("node:net");
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await new Promise<void>((r) => server.close(() => r()));
    await start();
  }, 30000);
  afterAll(async () => {
    await stop(worker);
    await stop(app);
    const c = await db.pool.getConnection();
    try {
      await c.beginTransaction();
      const allUsers = [userId, otherUserId, ...extraUsers];
      for (const table of [
        "upload_album_targets",
        "audit_logs",
        "purge_files",
        "media_location_projections",
        "album_media",
        "album_members",
        "invitations",
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
      await c.query(
        `DELETE FROM sessions WHERE user_id IN (${allUsers.map(() => "?").join(",")})`,
        allUsers,
      );
      await c.query(
        `DELETE FROM users WHERE id IN (${allUsers.map(() => "?").join(",")})`,
        allUsers,
      );
      await c.query("DELETE FROM families WHERE id=?", [familyId]);
      await c.commit();
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
      await db.pool.end();
      rmSync(rootPath, { recursive: true, force: true });
    }
  }, 30000);
  it("issues ANDROID tokens without cookies, preserves WEB contract and rejects type confusion", async () => {
    const login = await req(
      "/api/v1/auth/android/login",
      "POST",
      { username, password: "synthetic-password" },
      "",
    );
    expect(login.status).toBe(200);
    expect(login.headers.has("set-cookie")).toBe(false);
    token = (await login.json()).token;
    const identity = await authRepo.findSession(hashSessionToken(token));
    expect(identity?.clientType).toBe("ANDROID");
    sessionId = identity!.sessionId;
    const web = await req(
      "/api/v1/auth/login",
      "POST",
      { username, password: "synthetic-password" },
      "",
      { origin: "https://localhost:3000" },
    );
    expect(web.status).toBe(204);
    webToken = web.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
    expect(
      (await req("/api/v1/auth/me", "GET", undefined, webToken)).status,
    ).toBe(401);
    expect(
      (
        await req("/api/v1/auth/me", "GET", undefined, "", {
          cookie: `__Host-family_session=${token}`,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await req("/api/v1/auth/me", "GET", undefined, token, {
          cookie: "other=value",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await req("/api/v1/auth/me", "GET", undefined, token, {
          origin: "https://localhost:3000",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await req("/api/v1/auth/me", "GET", undefined, "", {
          cookie: `__Host-family_session=${webToken}`,
        })
      ).status,
    ).toBe(200);
    const other = await req(
      "/api/v1/auth/android/login",
      "POST",
      { username: `p10_other_${suffix}`, password: "synthetic-password" },
      "",
    );
    expect(other.status).toBe(200);
    otherToken = (await other.json()).token;
    for (const label of ["A", "B"]) {
      const a = await req("/api/v1/albums", "POST", {
        familyId,
        name: `Synthetic ${label}`,
        visibility: "CUSTOM",
      });
      expect(a.status).toBe(201);
      const id = (await a.json()).id;
      if (label === "A") albumA = id;
      else albumB = id;
    }
  }, 15000);
  it("lost create response/concurrent retries reserve exactly one receipt; immutable fingerprint survives target editing", async () => {
    expect(
      await loseResponse(`/api/v1/families/${familyId}/uploads/tus`, "POST", {
        authorization: `Bearer ${token}`,
        "tus-resumable": "1.0.0",
        "upload-length": String(bytes.length),
        "upload-client-id": operationId,
        "upload-target-albums": [albumA, albumB].join(","),
        "upload-metadata": `filename ${Buffer.from("synthetic.jpg").toString("base64")},filetype ${Buffer.from("image/jpeg").toString("base64")}`,
      }),
    ).toBe(201);
    // Resolve unknown client outcome first; retry create only after current
    // owner-scoped observation, rather than blindly replaying a lost response.
    const observed = await req(
      `/api/v1/families/${familyId}/uploads/operations/${operationId}`,
    );
    expect(observed.status).toBe(200);
    const observedUploadId = (await observed.json()).uploadId;
    const responses = await Promise.all([create(), create()]);
    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(
      responses[0]!.headers.get("location") ===
        responses[1]!.headers.get("location"),
    ).toBe(true);
    uploadId = responses[0]!.headers.get("location")!.split("/").at(-1)!;
    expect(uploadId).toBe(observedUploadId);
    const lookup = await req(
      `/api/v1/families/${familyId}/uploads/operations/${operationId}`,
    );
    expect(lookup.status).toBe(200);
    expect((await lookup.json()).uploadId).toBe(uploadId);
    const [count] = await db.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) n FROM upload_sessions WHERE family_id=? AND client_operation_id=UNHEX(?)",
      [familyId, operationId.replaceAll("-", "")],
    );
    expect(Number(count[0]?.n)).toBe(1);
    expect(
      (
        await req(`/api/v1/uploads/${uploadId}/targets`, "PUT", {
          albumIds: [albumA],
        })
      ).status,
    ).toBe(200);
    expect((await create()).status).toBe(201);
    const conflict = await create(operationId, [albumA]);
    expect(conflict.status, await conflict.text()).toBe(409);
    expect(
      (await create(operationId, [albumA, albumB], "changed.jpg")).status,
    ).toBe(409);
    expect(
      (
        await req(`/api/v1/uploads/${uploadId}/targets`, "PUT", {
          albumIds: [albumA, albumB],
        })
      ).status,
    ).toBe(200);
    expect((await result()).mediaId).toBeUndefined();
    expect(
      (
        await req(
          `/api/v1/uploads/${uploadId}/result`,
          "GET",
          undefined,
          otherToken,
        )
      ).status,
    ).toBe(404);
  });
  it("actual PATCH/finalize response loss and partial-offset process restart recover through authoritative HTTP observation", async () => {
    const path = `/api/v1/uploads/tus/${uploadId}`;
    const split = Math.floor(bytes.length / 2);
    expect(split).toBeGreaterThan(0);
    expect(split).toBeLessThan(bytes.length);
    expect(
      await loseResponse(
        path,
        "PATCH",
        {
          authorization: `Bearer ${token}`,
          "tus-resumable": "1.0.0",
          "upload-offset": "0",
          "content-type": "application/offset+octet-stream",
        },
        bytes.subarray(0, split),
      ),
    ).toBe(204);
    const partial = await req(path, "HEAD", undefined, token, {
      "tus-resumable": "1.0.0",
    });
    expect(partial.status).toBe(200);
    expect(partial.headers.get("upload-offset")).toBe(String(split));
    await stop(app, "SIGKILL");
    app = undefined;
    await start();
    expect((await req("/api/v1/auth/me")).status).toBe(200);
    const recovered = await req(
      `/api/v1/families/${familyId}/uploads/operations/${operationId}`,
    );
    expect(recovered.status).toBe(200);
    const recoveredReceipt = await recovered.json();
    expect(recoveredReceipt.uploadId).toBe(uploadId);
    expect(recoveredReceipt.committedOffset).toBe(String(split));
    const resumed = await req(path, "HEAD", undefined, token, {
      "tus-resumable": "1.0.0",
    });
    expect(resumed.status).toBe(200);
    expect(resumed.headers.get("upload-offset")).toBe(String(split));
    expect((await create()).headers.get("location")!.endsWith(uploadId)).toBe(
      true,
    );
    expect(
      await loseResponse(
        path,
        "PATCH",
        {
          authorization: `Bearer ${token}`,
          "tus-resumable": "1.0.0",
          "upload-offset": String(split),
          "content-type": "application/offset+octet-stream",
        },
        bytes.subarray(split),
      ),
    ).toBe(204);
    const head = await req(path, "HEAD", undefined, token, {
      "tus-resumable": "1.0.0",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("upload-offset")).toBe(String(bytes.length));
    const wrong = await fetch(base + path, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "tus-resumable": "1.0.0",
        "upload-offset": "0",
        "content-type": "application/offset+octet-stream",
      },
      body: new Uint8Array(bytes),
    });
    expect(wrong.status).toBe(409);
    expect(
      await loseResponse(
        `/api/v1/uploads/${uploadId}/finalize`,
        "POST",
        {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        "{}",
      ),
    ).toBe(200);
    expect((await result()).state).toBe("COMPLETE");
    await stop(app, "SIGKILL");
    app = undefined;
    await start();
    const receipt = await result();
    expect(receipt.state).toBe("COMPLETE");
    expect(receipt.mediaId).toBeUndefined();
    worker = spawn(
      process.execPath,
      ["--import", "tsx", "apps/worker/dist/metadata-main.js"],
      { env: env(), stdio: "ignore" },
    );
    try {
      await until(async () => {
        if (worker?.exitCode !== null)
          throw Error("PHASE10_METADATA_WORKER_EXITED");
        return (await result()).processing === "READY";
      });
    } catch (error) {
      const [jobs] = await db.pool.query<RowDataPacket[]>(
        "SELECT job_type jobType,state,last_failure_code failureCode FROM background_jobs WHERE family_id=? ORDER BY id",
        [familyId],
      );
      // Fixed categories only: never dump paths, parser errors, tokens or EXIF.
      console.error(JSON.stringify({ event: "phase10_fixture_jobs", jobs }));
      throw error;
    }
  }, 60000);
  it("atomic all-target ACL failure then explicit placement yields real pipeline/gallery media without modifying original", async () => {
    await db.pool.query(
      "UPDATE albums SET deleted_at=CURRENT_TIMESTAMP(3) WHERE family_id=? AND id=?",
      [familyId, albumB],
    );
    expect(
      (await req(`/api/v1/uploads/${uploadId}/placement`, "POST", {})).status,
    ).toBe(404);
    const [placements] = await db.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) n FROM album_media WHERE family_id=?",
      [familyId],
    );
    expect(Number(placements[0]?.n)).toBe(0);
    await db.pool.query(
      "UPDATE albums SET deleted_at=NULL WHERE family_id=? AND id=?",
      [familyId, albumB],
    );
    const originalPath = join(
      rootPath,
      buildOriginalPath(
        familyId,
        createHash("sha256").update(bytes).digest("hex"),
        String(bytes.length),
      ),
    );
    const inode = statSync(originalPath).ino;
    expect(
      await loseResponse(
        `/api/v1/uploads/${uploadId}/placement`,
        "POST",
        {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        "{}",
      ),
    ).toBe(200);
    const view = await result();
    expect(view.placement).toBe("APPLIED");
    mediaId = view.mediaId;
    expect(view.albumId).toBe(albumA);
    const gallery = await req(`/api/v1/albums/${albumA}/media`);
    expect(gallery.status).toBe(200);
    expect(JSON.stringify(await gallery.json()).includes(mediaId)).toBe(true);
    expect(readFileSync(originalPath).equals(bytes)).toBe(true);
    expect(statSync(originalPath).ino).toBe(inode);
    const binary = await req(`/api/v1/media/${mediaId}/derived/thumbnail`);
    expect(binary.status).toBe(200);
    expect((await binary.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const original = await req(
      `/api/v1/albums/${albumA}/media/${mediaId}/download/original`,
    );
    expect(original.status).toBe(200);
    expect(Buffer.from(await original.arrayBuffer()).equals(bytes)).toBe(true);
    const preview = await req(
      `/api/v1/albums/${albumA}/media/${mediaId}/download/preview`,
    );
    expect(preview.status).toBe(200);
    expect((await preview.arrayBuffer()).byteLength).toBeGreaterThan(0);

    expect(
      (
        await req(`/api/v1/uploads/${uploadId}/targets`, "PUT", {
          albumIds: [albumA],
        })
      ).status,
    ).toBe(409);
  });
  it("APPLIED removal/revocation never resurrects placement or returns stale identity; stale generation fails closed", async () => {
    await db.pool.query(
      "DELETE FROM album_media WHERE family_id=? AND media_id=?",
      [familyId, mediaId],
    );
    expect((await result()).mediaId).toBeUndefined();
    expect((await result()).placement).toBe("NEEDS_ALBUM_ACTION");
    expect(
      (await req(`/api/v1/uploads/${uploadId}/placement`, "POST", {})).status,
    ).toBe(200);
    const [p] = await db.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) n FROM album_media WHERE family_id=?",
      [familyId],
    );
    expect(Number(p[0]?.n)).toBe(0);
    await db.pool.query(
      "UPDATE media_items SET generation=generation+1,metadata_generation=generation WHERE family_id=? AND id=?",
      [familyId, mediaId],
    );
    expect((await result()).processing).not.toBe("READY");
    expect(
      (await req(`/api/v1/uploads/${uploadId}/placement`, "POST", {})).status,
    ).toBe(409);
    await db.pool.query(
      "UPDATE media_items SET generation=generation-1,metadata_generation=generation WHERE family_id=? AND id=?",
      [familyId, mediaId],
    );
  });
  it("hidden same-family dedup exposes no source ID until authorized placement and preserves canonical source", async () => {
    const a = await req(
      "/api/v1/albums",
      "POST",
      { familyId, name: "Other private", visibility: "CUSTOM" },
      otherToken,
    );
    expect(a.status).toBe(201);
    const otherAlbum = (await a.json()).id;
    otherAlbumId = otherAlbum;
    const duplicate = await create(
      randomUUID(),
      [otherAlbum],
      "synthetic.jpg",
      otherToken,
    );
    expect(duplicate.status).toBe(201);
    const id = duplicate.headers.get("location")!.split("/").at(-1)!;
    duplicateReceiptId = id;
    const patched = await fetch(base + `/api/v1/uploads/tus/${id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${otherToken}`,
        "tus-resumable": "1.0.0",
        "upload-offset": "0",
        "content-type": "application/offset+octet-stream",
      },
      body: new Uint8Array(bytes),
    });
    expect(patched.status).toBe(204);
    expect(
      (await req(`/api/v1/uploads/${id}/finalize`, "POST", {}, otherToken))
        .status,
    ).toBe(200);
    const safe = await result(id, otherToken);
    expect(safe.processing).toBe("READY");
    expect(safe.mediaId).toBeUndefined();
    expect(safe.albumId).toBeUndefined();
    expect(Object.keys(safe).sort()).toEqual([
      "committedOffset",
      "declaredSize",
      "placement",
      "processing",
      "retryable",
      "state",
      "uploadId",
    ]);
    const otherIdentity = await authRepo.findSession(
      hashSessionToken(otherToken),
    );
    const otherActor = {
      userId: otherUserId,
      sessionId: otherIdentity!.sessionId,
      tokenHash: hashSessionToken(otherToken),
      expectedClientType: "ANDROID" as const,
    };
    let inject = true;
    const wrapped = new Proxy(db.pool, {
      get(target, prop) {
        if (prop === "getConnection")
          return async () => {
            const c = await target.getConnection();
            return new Proxy(c, {
              get(connection, field) {
                if (field === "commit")
                  return async () => {
                    await connection.commit();
                    if (inject) {
                      inject = false;
                      throw Error("SYNTHETIC_PLACEMENT_ACK_LOSS");
                    }
                  };
                const value = Reflect.get(connection, field);
                return typeof value === "function"
                  ? value.bind(connection)
                  : value;
              },
            });
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Pool;
    const key = await uploads.discoverPlacementKey(
      otherActor,
      Buffer.from(id, "hex"),
    );
    const life = await new ContentCoordination(
      { mediaRoot: rootPath, expectedMarkerId: marker },
      {
        familyId,
        sha256Hex: key.sha256.toString("hex"),
        byteSize: key.byteSize,
      },
    ).acquireLifecycle("S", 30000);
    try {
      await expect(
        new MySqlUploadRepository(wrapped).place(
          otherActor,
          Buffer.from(id, "hex"),
          key,
        ),
      ).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    } finally {
      life.close();
    }
    // Fresh observation resolves the lost acknowledgement; no replay is needed.
    const observed = await result(id, otherToken);
    expect(observed.placement).toBe("APPLIED");
    expect(observed.mediaId).toBe(mediaId);
    const [source] = await db.pool.query<RowDataPacket[]>(
      "SELECT LOWER(HEX(u.public_id)) publicId FROM media_items m JOIN upload_sessions u ON u.id=m.source_upload_id WHERE m.family_id=? AND m.id=?",
      [familyId, mediaId],
    );
    expect(source[0]?.publicId).toBe(uploadId);
    await db.pool.query(
      "UPDATE family_members SET role='ADMIN' WHERE family_id=? AND user_id=?",
      [familyId, otherUserId],
    );
    expect(
      (
        await req(
          `/api/v1/uploads/${uploadId}/result`,
          "GET",
          undefined,
          otherToken,
        )
      ).status,
    ).toBe(404);
  });
  it("fresh lock-time type validation rejects a transport change while waiting on the family lock", async () => {
    const c = await db.pool.getConnection();
    await c.beginTransaction();
    await c.query("SELECT id FROM families WHERE id=? FOR UPDATE", [familyId]);
    const pending = uploads.result(
      {
        userId,
        sessionId,
        tokenHash: hashSessionToken(token),
        expectedClientType: "ANDROID",
      },
      Buffer.from(uploadId, "hex"),
    );
    const observation = pending.then(
      () => "ACCEPTED",
      (error) => error.reason,
    );
    try {
      await delay(30);
      await db.pool.query("UPDATE sessions SET client_type='WEB' WHERE id=?", [
        sessionId,
      ]);
      await c.commit();
      expect(await observation).toBe("UNAUTHENTICATED");
    } finally {
      await c.rollback();
      c.release();
      await db.pool.query(
        "UPDATE sessions SET client_type='ANDROID' WHERE id=?",
        [sessionId],
      );
    }
  });
  it("native invitation adapters retain new-account semantics, anonymous JSON policy and one-shot consume", async () => {
    const issued = await req(
      `/api/v1/families/${familyId}/invitations`,
      "POST",
      { role: "MEMBER" },
    );
    expect(issued.status).toBe(201);
    const invitation = new URLSearchParams(
      new URL((await issued.json()).invitationUrl).hash.slice(1),
    ).get("token")!;
    const previewPath = "/api/v1/android/invitations/preview";
    for (const headers of [
      { origin: "https://localhost:3000" },
      { cookie: "unrelated=value" },
    ])
      expect(
        (await req(previewPath, "POST", { token: invitation }, "", headers))
          .status,
      ).toBe(400);
    expect((await req(previewPath, "POST", { token: invitation })).status).toBe(
      400,
    );
    const preview = await req(previewPath, "POST", { token: invitation }, "");
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("no-store");
    expect(preview.headers.get("referrer-policy")).toBe("no-referrer");
    const consumePath = "/api/v1/android/invitations/consume";
    expect(
      (
        await req(
          consumePath,
          "POST",
          { token: invitation, username, password: "synthetic-password" },
          "",
        )
      ).status,
    ).toBe(409);
    const newName = `p10_invited_${suffix}`;
    const consumption = await Promise.all([
      req(
        consumePath,
        "POST",
        {
          token: invitation,
          username: newName,
          password: "synthetic-password",
        },
        "",
      ),
      req(
        consumePath,
        "POST",
        {
          token: invitation,
          username: newName,
          password: "synthetic-password",
        },
        "",
      ),
    ]);
    expect(consumption.filter((r) => r.status === 201).length).toBe(1);
    expect(
      consumption.every(
        (r) => r.status === 201 || r.status === 400 || r.status === 409,
      ),
    ).toBe(true);
    const [users] = await db.pool.query<RowDataPacket[]>(
      "SELECT CAST(id AS CHAR) id FROM users WHERE username_normalized=?",
      [Buffer.from(newName)],
    );
    expect(users.length).toBe(1);
    extraUsers.push(users[0]!.id);
    expect(
      (await req(previewPath, "POST", { token: invitation }, "")).status,
    ).toBe(400);
  }, 15000);
  it("unknown create COMMIT is observed fresh; mismatch cannot reserve twice", async () => {
    const operation = randomUUID();
    const key = Buffer.from(operation.replaceAll("-", ""), "hex");
    let inject = true;
    const wrapped = new Proxy(db.pool, {
      get(target, prop) {
        if (prop === "getConnection")
          return async () => {
            const c = await target.getConnection();
            return new Proxy(c, {
              get(connection, field) {
                if (field === "commit")
                  return async () => {
                    await connection.commit();
                    if (inject) {
                      inject = false;
                      throw Error("SYNTHETIC_ACK_LOSS");
                    }
                  };
                const value = Reflect.get(connection, field);
                return typeof value === "function"
                  ? value.bind(connection)
                  : value;
              },
            });
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Pool;
    const input = {
      actor: {
        userId,
        sessionId,
        tokenHash: hashSessionToken(token),
        expectedClientType: "ANDROID" as const,
      },
      familyId,
      publicId: randomBytes(16),
      originalFilename: "synthetic.jpg",
      reportedMime: "image/jpeg",
      declaredSize: BigInt(bytes.length),
      clientOperationId: key,
      targetAlbumIds: [albumA],
    };
    await expect(
      new MySqlUploadRepository(wrapped).createUpload(input),
    ).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    const observation = await uploads.findOperation({
      actor: input.actor,
      familyId,
      clientOperationId: key,
    });
    expect(observation.state).toBe("CREATED");
    const retry = await uploads.createUpload({
      ...input,
      publicId: randomBytes(16),
    });
    expect(retry.reused).toBe(true);
    expect(retry.publicId).toBe(observation.publicId);
    // COMMIT can precede staging creation. Identity recovery is not proof that
    // HEAD/PATCH can resume, and retry must never manufacture a replacement payload.
    const path = join(
      rootPath,
      buildUploadPayloadPath(familyId, observation.publicId),
    );
    expect(existsSync(path)).toBe(false);
    const head = await req(
      `/api/v1/uploads/tus/${observation.publicId}`,
      "HEAD",
      undefined,
      token,
      { "tus-resumable": "1.0.0" },
    );
    expect(head.status).toBe(503);
    const recovered = await create(operation, [albumA]);
    // Capacity inventory also fails closed on the missing staging payload.
    expect(recovered.status).toBe(503);
    const lookup = await req(
      `/api/v1/families/${familyId}/uploads/operations/${operation}`,
    );
    expect(lookup.status).toBe(200);
    expect((await lookup.json()).uploadId).toBe(observation.publicId);
    expect(existsSync(path)).toBe(false);
    const [counts] = await db.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) n FROM upload_sessions WHERE family_id=? AND client_operation_id=?",
      [familyId, key],
    );
    expect(Number(counts[0]!.n)).toBe(1);
  });
  it("reauth locks exact DB type, rotates without extending expiry; mixed-session logout-all revokes both", async () => {
    const before = await authRepo.findSession(hashSessionToken(token));
    await expect(
      authRepo.rotateSession({
        userId,
        sessionId,
        oldTokenHash: hashSessionToken(token),
        newTokenHash: hashSessionToken(createSessionToken()),
        expectedPasswordHash: passwordHash,
        expectedClientType: "WEB",
      }),
    ).rejects.toMatchObject({ reason: "UNAUTHENTICATED" });
    const rotated = await req("/api/v1/auth/android/reauth", "POST", {
      password: "synthetic-password",
    });
    expect(rotated.status).toBe(200);
    const issued = await rotated.json();
    expect(issued.expiresAt).toBe(before!.expiresAt.toISOString());
    const oldToken = token;
    token = issued.token;
    expect(
      (await req("/api/v1/auth/me", "GET", undefined, oldToken)).status,
    ).toBe(401);
    expect((await req("/api/v1/auth/logout-all", "POST", {})).status).toBe(204);
    expect((await req("/api/v1/auth/me")).status).toBe(401);
    expect(
      (
        await req("/api/v1/auth/me", "GET", undefined, "", {
          cookie: `__Host-family_session=${webToken}`,
        })
      ).status,
    ).toBe(401);
  }, 15000);
  it("native password replacement preserves transport and revokes prior Web and Android sessions", async () => {
    const login = await req(
      "/api/v1/auth/android/login",
      "POST",
      { username, password: "synthetic-password" },
      "",
    );
    expect(login.status).toBe(200);
    token = (await login.json()).token;
    const web = await req(
      "/api/v1/auth/login",
      "POST",
      { username, password: "synthetic-password" },
      "",
      { origin: "https://localhost:3000" },
    );
    expect(web.status).toBe(204);
    const oldWeb = web.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
    const oldNative = token;
    const replacement = await req("/api/v1/auth/android/password", "POST", {
      currentPassword: "synthetic-password",
      newPassword: "synthetic-next-password",
    });
    expect(replacement.status).toBe(200);
    expect(replacement.headers.has("set-cookie")).toBe(false);
    token = (await replacement.json()).token;
    expect(
      (await authRepo.findSession(hashSessionToken(token)))?.clientType,
    ).toBe("ANDROID");
    expect(
      (await req("/api/v1/auth/me", "GET", undefined, oldNative)).status,
    ).toBe(401);
    expect(
      (
        await req("/api/v1/auth/me", "GET", undefined, "", {
          cookie: `__Host-family_session=${oldWeb}`,
        })
      ).status,
    ).toBe(401);
    const current = await authRepo.findSession(hashSessionToken(token));
    expect(
      (await req(`/api/v1/auth/sessions/${current!.sessionId}`, "DELETE", {}))
        .status,
    ).toBe(204);
    expect((await req("/api/v1/auth/me")).status).toBe(401);
  }, 15000);
  it("new targets do not block actual Trash/purge retirement; historical APPLIED cannot resurrect retired content", async () => {
    const [revision] = await db.pool.query<RowDataPacket[]>(
      "SELECT CAST(lifecycle_revision AS CHAR) revision FROM media_items WHERE family_id=? AND id=?",
      [familyId, mediaId],
    );
    const trashed = await req(
      `/api/v1/families/${familyId}/media/${mediaId}/trash`,
      "POST",
      {
        selectedAlbumId: otherAlbumId,
        expectedLifecycleRevision: revision[0]!.revision,
        operationId: randomUUID(),
      },
      otherToken,
    );
    expect(trashed.status).toBe(200);
    const lifecycle = (await trashed.json()).lifecycleRevision;
    expect(
      (await result(duplicateReceiptId, otherToken)).mediaId,
    ).toBeUndefined();
    expect(
      (
        await req(
          `/api/v1/uploads/${duplicateReceiptId}/placement`,
          "POST",
          {},
          otherToken,
        )
      ).status,
    ).toBe(409);
    // Only this owned synthetic fixture's clock is advanced through the existing retention contract.
    await db.pool.query(
      "UPDATE media_items SET trashed_at=UTC_TIMESTAMP(3)-INTERVAL 31 DAY,purge_after=UTC_TIMESTAMP(3)-INTERVAL 1 DAY WHERE family_id=? AND id=?",
      [familyId, mediaId],
    );
    const purge = await req(
      `/api/v1/families/${familyId}/trash/${mediaId}/permanent-delete`,
      "POST",
      { expectedLifecycleRevision: lifecycle, operationId: randomUUID() },
      otherToken,
    );
    expect(purge.status).toBe(202);
    await stop(worker);
    worker = undefined;
    await stop(app);
    app = undefined;
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
      // Do not claim any other DEV family's pending purge.
      const [others] = await db.pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) n FROM purge_intents WHERE family_id<>? AND execution_state IN ('QUEUED','RUNNING','RETRY_WAIT')",
        [familyId],
      );
      expect(Number(others[0]!.n)).toBe(0);
      const processor = new PurgeProcessor(db.pool, root, store, gate);
      const lease = await processor.repository.claim();
      expect(lease).not.toBeNull();
      const [claimed] = await db.pool.query<RowDataPacket[]>(
        "SELECT CAST(family_id AS CHAR) familyId FROM purge_intents WHERE id=?",
        [lease!.id],
      );
      expect(claimed[0]!.familyId).toBe(familyId);
      expect(await processor.run(lease!)).toBe("COMPLETED");
      const [receipts] = await db.pool.query<RowDataPacket[]>(
        "SELECT state FROM upload_sessions WHERE family_id=? AND completed_at IS NOT NULL",
        [familyId],
      );
      expect(receipts.length).toBe(2);
      expect(receipts.every((row) => row.state === "RETIRED")).toBe(true);
      const [historical] = await db.pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) n FROM upload_album_targets WHERE family_id=? AND state='APPLIED'",
        [familyId],
      );
      expect(Number(historical[0]!.n)).toBe(3);
    } finally {
      gate.close();
      store.close();
      root.close();
    }
    await start();
    const observation = await result(duplicateReceiptId, otherToken);
    expect(observation.state).toBe("RETIRED");
    expect(observation.processing).toBe("UNAVAILABLE");
    expect(observation.mediaId).toBeUndefined();
    expect(
      (
        await req(
          `/api/v1/uploads/${duplicateReceiptId}/placement`,
          "POST",
          {},
          otherToken,
        )
      ).status,
    ).toBe(404);
  }, 30000);
});
