import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../../apps/api/src/app.js";
import type { AuthService } from "../../apps/api/src/auth/service.js";
import { DerivedReadService } from "../../apps/api/src/derived-serving/service.js";
import {
  assertMigrationReadiness,
  createDatabase,
  MySqlDerivedReadRepository,
} from "../../packages/db/src/index.js";
import { CapacityGate, StorageRoot } from "../../packages/storage/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE4D3C2_DEV_DATABASE_URL_REQUIRED");

const token = "synthetic-session-token";
const thumbnail = Buffer.from("synthetic-thumbnail-webp");
const preview = Buffer.from("synthetic-preview-webp");
const thumbnailSha = createHash("sha256").update(thumbnail).digest("hex");
const previewSha = createHash("sha256").update(preview).digest("hex");

type Query = {
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<[ResultSetHeader, unknown]>;
};

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true });
  const segments = path.split("/");
  const rootIndex = segments.findIndex((segment) =>
    segment.startsWith("ps4d3c2-serve-"),
  );
  const start = rootIndex >= 0 ? rootIndex : segments.length - 1;
  for (let index = start; index < segments.length; index += 1) {
    chmodSync(segments.slice(0, index + 1).join("/"), 0o700);
  }
}

describe.sequential("Phase 4D3c-2 derived serving", () => {
  const database = createDatabase(databaseUrl!);
  const suffix = randomUUID().replaceAll("-", "");
  const mediaRoot = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3c2-serve-"));
  privateDirectory(mediaRoot);
  privateDirectory(join(mediaRoot, "derived"));
  const storageRoot = StorageRoot.open(mediaRoot, { initialize: true });
  storageRoot.provisionSharedCapacityLockForDev();
  const gate = CapacityGate.open({
    mediaRoot: storageRoot.canonicalPath,
    expectedMarkerId: storageRoot.markerId,
  });
  const jobs = new Map<string, string>();
  const users = new Map<string, string>();
  const reads: Array<Record<string, unknown>> = [];
  let userId = "";
  let familyA = "";
  let familyB = "";
  let viewer = "";
  let outsider = "";
  let admin = "";
  let foreignUser = "";
  let ownerUser = "";
  let albumId = "";
  let deletedAlbumId = "";
  let visibleMedia = "";
  let orphanMedia = "";
  let deletedMedia = "";
  let stateMedia = "";
  let blockedMedia = "";

  const authService = {
    authenticate: vi.fn(async () => ({
      identity: { userId, sessionId: "1" },
      tokenHash: Buffer.alloc(32),
    })),
  } as unknown as AuthService;
  const app = createApp({
    authService,
    derivedService: new DerivedReadService(
      new MySqlDerivedReadRepository(database.pool),
      {
        async read(identity) {
          reads.push({ ...identity });
          return gate.withLock(() =>
            Promise.resolve(gate.readDerivedFinal(identity)),
          );
        },
      },
    ),
    trustedOrigins: new Set(["https://localhost:3000"]),
  });

  beforeAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      const [identity] = await connection.query<RowDataPacket[]>(
        `SELECT DATABASE() AS db, VERSION() AS version,
          CURRENT_USER() AS account,
          @@GLOBAL.innodb_native_foreign_keys AS nativeFk,
          @@SESSION.foreign_key_checks AS foreignKeyChecks`,
      );
      const row = identity[0];
      if (
        row?.db !== "family_album_dev" ||
        !String(row.version).startsWith("9.7.2") ||
        String(row.account).split("@")[0]?.toLowerCase() === "root" ||
        String(row.nativeFk) !== "1" ||
        String(row.foreignKeyChecks) !== "1"
      ) {
        throw new Error("PHASE4D3C2_DEV_PREFLIGHT_FAILED");
      }
      await assertMigrationReadiness(connection);
      familyA = await insertFamily(connection, `A ${suffix}`);
      familyB = await insertFamily(connection, `B ${suffix}`);
      const owner = await insertMember(connection, familyA, `owner_${suffix}`, "MEMBER");
      ownerUser = users.get(owner) ?? "";
      viewer = await insertMember(connection, familyA, `viewer_${suffix}`, "MEMBER");
      outsider = await insertMember(connection, familyA, `out_${suffix}`, "MEMBER");
      admin = await insertMember(connection, familyA, `admin_${suffix}`, "ADMIN");
      foreignUser = await insertMember(connection, familyB, `foreign_${suffix}`, "MEMBER");
      albumId = await insertAlbum(connection, familyA, owner, "CUSTOM");
      deletedAlbumId = await insertAlbum(connection, familyA, owner, "FAMILY");
      await connection.query(
        `INSERT INTO album_members (family_id, album_id, member_id, can_view)
         VALUES (?,?,?,1)`,
        [familyA, albumId, viewer],
      );
      visibleMedia = await insertMedia(connection, familyA, owner);
      orphanMedia = await insertMedia(connection, familyA, owner);
      deletedMedia = await insertMedia(connection, familyA, owner);
      stateMedia = await insertMedia(connection, familyA, owner);
      blockedMedia = await insertMedia(connection, familyA, owner);
      for (const mediaId of [
        visibleMedia,
        orphanMedia,
        deletedMedia,
        stateMedia,
        blockedMedia,
      ]) {
        seal(familyA, mediaId);
      }
      await insertReady(connection, familyA, visibleMedia, "THUMBNAIL", thumbnail, thumbnailSha);
      await insertReady(connection, familyA, visibleMedia, "PREVIEW", preview, previewSha);
      await insertReady(connection, familyA, orphanMedia, "THUMBNAIL", thumbnail, thumbnailSha);
      await insertReady(connection, familyA, deletedMedia, "THUMBNAIL", thumbnail, thumbnailSha);
      await insertReady(connection, familyA, blockedMedia, "THUMBNAIL", thumbnail, thumbnailSha);
      for (const [album, mediaId] of [
        [albumId, visibleMedia],
        [albumId, stateMedia],
        [deletedAlbumId, deletedMedia],
        [albumId, blockedMedia],
      ] as const) {
        await connection.query(
          `INSERT INTO album_media (family_id, album_id, media_id) VALUES (?,?,?)`,
          [familyA, album, mediaId],
        );
      }
      await connection.query(
        `UPDATE albums SET deleted_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
        [deletedAlbumId],
      );
      await connection.query(
        `UPDATE media_items
            SET processing_state='BLOCKED', last_failure_code='ORIGINAL_MISSING'
          WHERE id=?`,
        [blockedMedia],
      );
    } finally {
      connection.release();
    }
  });

  afterAll(async () => {
    await app.close();
    const ids = [familyA, familyB].filter((id) => id !== "");
    if (ids.length > 0) {
      await database.pool.query("DELETE FROM album_members WHERE family_id IN (?)", [ids]);
      await database.pool.query("DELETE FROM album_media WHERE family_id IN (?)", [ids]);
      await database.pool.query("DELETE FROM derived_assets WHERE family_id IN (?)", [ids]);
      await database.pool.query("DELETE FROM background_jobs WHERE family_id IN (?)", [ids]);
      await database.pool.query("DELETE FROM media_items WHERE family_id IN (?)", [ids]);
      await database.pool.query("DELETE FROM upload_sessions WHERE family_id IN (?)", [ids]);
      await database.pool.query("DELETE FROM storage_objects WHERE family_id IN (?)", [ids]);
      await database.pool.query("DELETE FROM albums WHERE family_id IN (?)", [ids]);
      await database.pool.query("DELETE FROM family_members WHERE family_id IN (?)", [ids]);
      const userIds = [ownerUser, users.get(viewer), users.get(outsider), users.get(admin), users.get(foreignUser)].filter(
        (id): id is string => Boolean(id),
      );
      if (userIds.length > 0) {
        await database.pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
      }
      await database.pool.query("DELETE FROM families WHERE id IN (?)", [ids]);
    }
    storageRoot.close();
    rmSync(mediaRoot, { recursive: true, force: true });
    await database.pool.end();
  });

  it("serves thumbnail and preview to an album member", async () => {
    userId = users.get(viewer) ?? "";
    const thumb = await read(visibleMedia, "thumbnail");
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers["content-type"]).toBe("image/webp");
    expect(thumb.headers["content-length"]).toBe(String(thumbnail.length));
    expect(thumb.headers["cache-control"]).toBe("private, no-store");
    expect(thumb.rawPayload.equals(thumbnail)).toBe(true);
    expect(reads.at(-1)).not.toHaveProperty("path");
    expect(reads.at(-1)).not.toHaveProperty("filename");
    const shown = await read(visibleMedia, "preview");
    expect(shown.statusCode).toBe(200);
    expect(shown.rawPayload.equals(preview)).toBe(true);
  });

  it("uses one not-found result for hidden, missing, and cross-family media", async () => {
    const before = reads.length;
    for (const [actor, mediaId] of [
      [outsider, visibleMedia],
      [admin, visibleMedia],
      [foreignUser, visibleMedia],
      [viewer, orphanMedia],
      [viewer, deletedMedia],
      [viewer, blockedMedia],
    ] as const) {
      userId = users.get(actor) ?? "";
      const response = await read(mediaId, "thumbnail");
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      });
    }
    expect(reads).toHaveLength(before);
  });

  it("does not serve a derived row that is not READY", async () => {
    userId = users.get(viewer) ?? "";
    const before = reads.length;
    for (const state of ["RESERVED", "PUBLISHING", "FAILED", "MISSING"] as const) {
      await replaceDerived(state);
      const response = await read(stateMedia, "thumbnail");
      expect(response.statusCode).toBe(404);
      expect(JSON.stringify(response.json())).not.toContain(state);
    }
    expect(reads).toHaveLength(before);
  });

  it("does not serve a missing final or a digest mismatch", async () => {
    userId = users.get(viewer) ?? "";
    await insertReady(database.pool, familyA, stateMedia, "THUMBNAIL", thumbnail, "b".repeat(64));
    const mismatch = await read(stateMedia, "thumbnail");
    expect(mismatch.statusCode).toBe(404);
    expect(mismatch.json()).toMatchObject({ code: "NOT_FOUND" });
    rmSync(join(mediaRoot, "derived", familyA, stateMedia), {
      recursive: true,
      force: true,
    });
    await insertReady(database.pool, familyA, stateMedia, "THUMBNAIL", thumbnail, thumbnailSha);
    const absent = await read(stateMedia, "thumbnail");
    expect(absent.statusCode).toBe(404);
  });

  it("does not treat a path, filename, or original kind as a storage key", async () => {
    userId = users.get(viewer) ?? "";
    const before = reads.length;
    for (const url of [
      `/api/v1/media/${visibleMedia}/derived/original`,
      `/api/v1/media/${visibleMedia}/derived/..%2F..%2Foriginals`,
      `/api/v1/media/${visibleMedia}/derived/thumbnail.webp`,
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { cookie: `__Host-family_session=${token}` },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
    const unauthenticated = await app.inject({
      method: "GET",
      url: `/api/v1/media/${visibleMedia}/derived/thumbnail`,
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(reads).toHaveLength(before);
  });

  function read(mediaId: string, kind: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/media/${mediaId}/derived/${kind}`,
      headers: { cookie: `__Host-family_session=${token}` },
    });
  }

  function seal(familyId: string, mediaId: string) {
    const directory = join(mediaRoot, "derived", familyId, mediaId, "r1", "g1");
    privateDirectory(directory);
    for (const [name, bytes] of [
      ["thumbnail.webp", thumbnail],
      ["preview.webp", preview],
    ] as const) {
      const file = join(directory, name);
      writeFileSync(file, bytes, { mode: 0o600 });
      chmodSync(file, 0o400);
    }
  }

  async function insertFamily(connection: Query, name: string) {
    const [family] = await connection.query(
      "INSERT INTO families (name) VALUES (?)",
      [name],
    );
    return String(family.insertId);
  }

  async function insertMember(
    connection: Query,
    familyId: string,
    username: string,
    role: "MEMBER" | "ADMIN",
  ) {
    const [user] = await connection.query(
      `INSERT INTO users
        (username,username_normalized,password_hash,display_name,password_changed_at)
       VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
      [username, Buffer.from(username), "synthetic-not-used", "Derived"],
    );
    const [member] = await connection.query(
      "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,?)",
      [familyId, String(user.insertId), role],
    );
    const memberId = String(member.insertId);
    users.set(memberId, String(user.insertId));
    return memberId;
  }

  async function insertAlbum(
    connection: Query,
    familyId: string,
    ownerMemberId: string,
    visibility: "FAMILY" | "CUSTOM",
  ) {
    const [album] = await connection.query(
      `INSERT INTO albums (family_id, owner_member_id, name, visibility)
       VALUES (?,?,?,?)`,
      [familyId, ownerMemberId, "Synthetic", visibility],
    );
    return String(album.insertId);
  }

  async function insertMedia(connection: Query, familyId: string, memberId: string) {
    const sha = randomBytes(32);
    const [object] = await connection.query(
      `INSERT INTO storage_objects
        (family_id,sha256,byte_size,key_version,state,durable_at,verified_at)
       VALUES (?,?,8,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
      [familyId, sha],
    );
    const [upload] = await connection.query(
      `INSERT INTO upload_sessions
        (public_id,family_id,created_by_member_id,original_filename,
         declared_size,committed_offset,state,computed_sha256,
         finalize_started_at,storage_object_id,completed_at,expires_at)
       VALUES (?,?,?,'synthetic.png',8,8,'COMPLETE',?,
         CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),
         DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))`,
      [randomBytes(16), familyId, memberId, sha, String(object.insertId)],
    );
    const [media] = await connection.query(
      `INSERT INTO media_items
        (family_id,storage_object_id,source_upload_id,uploaded_at,timeline_key)
       VALUES (?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
      [familyId, String(object.insertId), String(upload.insertId)],
    );
    const mediaId = String(media.insertId);
    const [job] = await connection.query(
      `INSERT INTO background_jobs
        (family_id,media_id,generation,recipe_id,job_type,state,available_at)
       VALUES (?,?,1,1,'IMAGE_DERIVATIVES','QUEUED',CURRENT_TIMESTAMP(3))`,
      [familyId, mediaId],
    );
    jobs.set(mediaId, String(job.insertId));
    return mediaId;
  }

  async function insertReady(
    connection: Query,
    familyId: string,
    mediaId: string,
    kind: "THUMBNAIL" | "PREVIEW",
    bytes: Buffer,
    sha: string,
  ) {
    await connection.query("DELETE FROM derived_assets WHERE family_id=? AND media_id=? AND kind=?", [
      familyId,
      mediaId,
      kind,
    ]);
    await connection.query(
      `INSERT INTO derived_assets
        (family_id,media_id,generation,recipe_id,kind,state,reserved_bytes,
         byte_size,sha256,width,height,output_mime,producer_job_id,
         producer_lease_epoch,published_at)
       VALUES (?,?,1,1,?,'READY',?,?,?,8,4,'image/webp',?,1,CURRENT_TIMESTAMP(3))`,
      [
        familyId,
        mediaId,
        kind,
        bytes.length,
        bytes.length,
        Buffer.from(sha, "hex"),
        jobs.get(mediaId),
      ],
    );
  }

  async function replaceDerived(
    state: "RESERVED" | "PUBLISHING" | "FAILED" | "MISSING",
  ) {
    await database.pool.query(
      "DELETE FROM derived_assets WHERE family_id=? AND media_id=? AND kind='THUMBNAIL'",
      [familyA, stateMedia],
    );
    if (state === "RESERVED") {
      await database.pool.query(
        `INSERT INTO derived_assets
          (family_id,media_id,generation,recipe_id,kind,state,reserved_bytes,producer_job_id)
         VALUES (?,?,1,1,'THUMBNAIL','RESERVED',?,?)`,
        [familyA, stateMedia, thumbnail.length, jobs.get(stateMedia)],
      );
      return;
    }
    if (state === "FAILED" || state === "MISSING") {
      await database.pool.query(
        `INSERT INTO derived_assets
          (family_id,media_id,generation,recipe_id,kind,state,reserved_bytes,
           producer_job_id,failure_code)
         VALUES (?,?,1,1,'THUMBNAIL',?, ?,?,'UNSUPPORTED_FORMAT')`,
        [familyA, stateMedia, state, thumbnail.length, jobs.get(stateMedia)],
      );
      return;
    }
    await database.pool.query(
      `INSERT INTO derived_assets
        (family_id,media_id,generation,recipe_id,kind,state,reserved_bytes,
         byte_size,sha256,width,height,output_mime,producer_job_id,producer_lease_epoch)
       VALUES (?,?,1,1,'THUMBNAIL','PUBLISHING',?,?,?,8,4,'image/webp',?,1)`,
      [
        familyA,
        stateMedia,
        thumbnail.length,
        thumbnail.length,
        Buffer.from(thumbnailSha, "hex"),
        jobs.get(stateMedia),
      ],
    );
  }
});
