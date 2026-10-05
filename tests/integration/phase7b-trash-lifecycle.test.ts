import { freshStorageRootPath } from "../fixtures/fresh-storage-root.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rmSync, mkdirSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  PoolConnection,
  RowDataPacket,
  ResultSetHeader,
} from "mysql2/promise";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  acquireCheckedConnection,
  assertMigrationReadiness,
  loadExpectedMigrationManifest,
  createDatabase,
  MySqlTrashRepository,
  MySqlAlbumRepository,
  MySqlJobRepository,
  MySqlMetadataRepository,
  MySqlDerivedAssetFence,
  MySqlUploadRepository,
  MySqlMediaRepository,
  MySqlDerivedReadRepository,
  MySqlShareRepository,
  type LeaseFence,
} from "../../packages/db/dist/index.js";
import {
  createPhase6SchemaFixture,
  cleanupPhase6MigrationFixture,
} from "../../packages/db/scripts/phase6-schema-fixture.js";
import {
  OriginalReader,
  StorageRoot,
  CapacityGate,
} from "../../packages/storage/src/index.js";
import { ContentCoordination } from "../../packages/storage/src/phase7-coordination.js";
import { TrashService } from "../../apps/api/src/trash/service.js";
import type { AuthContext } from "../../apps/api/src/auth/service.js";
import { coordinatedDerivedReader } from "../../apps/api/src/derived-serving/reader.js";
import {
  OriginalDownloadService,
  type OriginalDownloadReader,
} from "../../apps/api/src/original-download/service.js";
import { DerivedReadService } from "../../apps/api/src/derived-serving/service.js";
import { PublicShareService } from "../../apps/api/src/shares/public-service.js";
import { AlbumService } from "../../apps/api/src/albums/service.js";
import { createApp } from "../../apps/api/src/app.js";
import { Readable } from "node:stream";
import { UploadService } from "../../apps/api/src/uploads/service.js";
import { ShareService } from "../../apps/api/src/shares/service.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("PHASE7B_DEV_ENV_REQUIRED");
type Fixture = Awaited<ReturnType<typeof createPhase6SchemaFixture>>;

describe.sequential("Phase 7B live lifecycle authorization and fences", () => {
  const db = createDatabase(url),
    repo = new MySqlTrashRepository(db.pool),
    albums = new MySqlAlbumRepository(db.pool);
  const jobs = new MySqlJobRepository(db.pool),
    metadata = new MySqlMetadataRepository(db.pool),
    assets = new MySqlDerivedAssetFence(db.pool);
  let c: PoolConnection,
    f: Fixture,
    dir: string,
    root: StorageRoot,
    service: TrashService;
  let owner: AuthContext, other: AuthContext, albumId: string;
  let gate: CapacityGate | undefined;
  const bytes = Buffer.from("Phase7B Original");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const actor = (context: AuthContext) => ({
    userId: context.identity.userId,
    sessionId: context.identity.sessionId,
    tokenHash: context.tokenHash,
  });
  async function insert(sql: string, values: unknown[]) {
    const [changed] = await c.query<ResultSetHeader>(sql, values);
    return String(changed.insertId);
  }
  async function session(userId: string): Promise<AuthContext> {
    const tokenHash = randomBytes(32);
    const sessionId = await insert(
      `INSERT INTO sessions (user_id,token_hash,client_type,authenticated_at,last_seen_at,expires_at,created_at)
      VALUES (?,?,'WEB',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY),CURRENT_TIMESTAMP(3))`,
      [userId, tokenHash],
    );
    return {
      identity: { userId, sessionId } as AuthContext["identity"],
      tokenHash,
    };
  }
  async function placement(
    ownerId: string,
    visibility = "CUSTOM",
    deleted = false,
  ) {
    const id = await insert(
      "INSERT INTO albums (family_id,owner_member_id,name,visibility,deleted_at) VALUES (?,?,?, ?,?)",
      [
        f.familyId,
        ownerId,
        "Synthetic 7B",
        visibility,
        deleted ? new Date() : null,
      ],
    );
    await c.query(
      "INSERT INTO album_media (family_id,album_id,media_id) VALUES (?,?,?)",
      [f.familyId, id, f.mediaId],
    );
    return id;
  }
  const trash = (
    context = owner,
    revision = "1",
    operationId = randomUUID(),
    selectedAlbumId = albumId,
  ) =>
    service.mutate(context, {
      familyId: f.familyId,
      mediaId: f.mediaId,
      selectedAlbumId,
      expectedLifecycleRevision: revision,
      operationId,
      action: "TRASH",
    });
  const restore = (revision = "2", operationId = randomUUID()) =>
    service.mutate(owner, {
      familyId: f.familyId,
      mediaId: f.mediaId,
      expectedLifecycleRevision: revision,
      operationId,
      action: "RESTORE",
    });
  async function row() {
    const [rows] = await c.query<RowDataPacket[]>(
      "SELECT *,CAST(lifecycle_revision AS CHAR) revision FROM media_items WHERE family_id=? AND id=?",
      [f.familyId, f.mediaId],
    );
    return rows[0]!;
  }
  async function derivedFixture() {
    const output = Buffer.from("Synthetic verified derived Buffer");
    const job = await jobs.enqueue({
      familyId: f.familyId,
      mediaId: f.mediaId,
      generation: 1n,
      recipeId: 1,
      jobType: "IMAGE_DERIVATIVES",
    });
    const digest = createHash("sha256").update(output).digest("hex");
    await insert(
      `INSERT INTO derived_assets (family_id,media_id,generation,recipe_id,kind,state,reserved_bytes,byte_size,sha256,
      width,height,output_mime,producer_job_id,producer_lease_epoch,published_at)
      VALUES (?,?,1,1,'PREVIEW','READY',4194304,?,?,1,1,'image/webp',?,1,CURRENT_TIMESTAMP(3))`,
      [
        f.familyId,
        f.mediaId,
        output.length,
        Buffer.from(digest, "hex"),
        job.job.id,
      ],
    );
    const directory = join(dir, "derived", f.familyId, f.mediaId, "r1", "g1");
    mkdirSync(directory, { recursive: true });
    let current = join(dir, "derived");
    for (const segment of [f.familyId, f.mediaId, "r1", "g1"]) {
      chmodSync(current, 0o700);
      current = join(current, segment);
    }
    chmodSync(current, 0o700);
    writeFileSync(join(directory, "preview.webp"), output, { mode: 0o400 });
    root.provisionSharedCapacityLockForDev();
    gate = CapacityGate.open({
      mediaRoot: dir,
      expectedMarkerId: root.markerId,
    });
    return {
      output,
      reader: coordinatedDerivedReader({ state: "READ_WRITE", root }, gate),
    };
  }
  async function extraMedia(visibility = "FAMILY", deleted = false) {
    const digest = randomBytes(32);
    const object = await insert(
      "INSERT INTO storage_objects (family_id,sha256,byte_size,state,durable_at,verified_at) VALUES (?,?,16,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))",
      [f.familyId, digest],
    );
    const upload = await insert(
      `INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,computed_sha256,finalize_started_at,storage_object_id,completed_at,expires_at)
      VALUES (?,?,?,'synthetic-extra.bin',16,16,'COMPLETE',?,CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))`,
      [randomBytes(16), f.familyId, f.memberId, digest, object],
    );
    const media = await insert(
      "INSERT INTO media_items (family_id,storage_object_id,source_upload_id,uploaded_at,timeline_key) VALUES (?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))",
      [f.familyId, object, upload],
    );
    const album = await insert(
      "INSERT INTO albums (family_id,owner_member_id,name,visibility,deleted_at) VALUES (?,?, 'Synthetic 7B extra',?,?)",
      [f.familyId, f.memberId, visibility, deleted ? new Date() : null],
    );
    await c.query(
      "INSERT INTO album_media (family_id,album_id,media_id) VALUES (?,?,?)",
      [f.familyId, album, media],
    );
    return { media, album };
  }

  beforeAll(async () => {
    const connection = await acquireCheckedConnection(db.pool);
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT DATABASE() db,CURRENT_USER() account",
      );
      expect(rows[0]?.db).toBe("family_album_dev");
      expect(String(rows[0]?.account).split("@")[0]).not.toBe("root");
      expect((await assertMigrationReadiness(connection)).migrationCount).toBe(
        (await loadExpectedMigrationManifest()).length,
      );
    } finally {
      connection.release();
    }
  });
  beforeEach(async () => {
    c = await acquireCheckedConnection(db.pool);
    await c.beginTransaction();
    try {
      f = await createPhase6SchemaFixture(c);
      await c.commit();
    } catch (error) {
      await c.rollback();
      throw error;
    }
    dir = freshStorageRootPath("phase7b-lifecycle-");
    root = StorageRoot.open(dir, { initialize: true });
    root.createUploadPayload(f.familyId, "7".repeat(32), bytes);
    root.publishOriginal({
      familyId: f.familyId,
      uploadId: "7".repeat(32),
      sha256Hex: sha,
      byteSize: String(bytes.length),
    });
    await c.query(
      "UPDATE storage_objects SET sha256=?,byte_size=? WHERE family_id=? AND id=?",
      [Buffer.from(sha, "hex"), bytes.length, f.familyId, f.objectId],
    );
    await c.query(
      "UPDATE upload_sessions SET computed_sha256=?,declared_size=?,committed_offset=? WHERE family_id=? AND id=?",
      [
        Buffer.from(sha, "hex"),
        bytes.length,
        bytes.length,
        f.familyId,
        f.uploadId,
      ],
    );
    owner = await session(f.userId);
    other = await session(f.actorUserId);
    albumId = await placement(f.memberId);
    service = new TrashService(repo, { state: "READ_WRITE", root });
  });
  afterEach(async () => {
    try {
      await c.rollback();
      await c.beginTransaction();
      for (const table of [
        "audit_logs",
        "user_favorites",
        "family_featured",
        "media_tags",
        "comments",
        "tags",
        "derived_assets",
        "background_jobs",
        "album_media",
        "album_members",
        "share_events",
        "shares",
        "albums",
      ])
        await c.query(`DELETE FROM ${table} WHERE family_id=?`, [f.familyId]);
      await c.query("DELETE FROM sessions WHERE user_id IN (?,?)", [
        f.userId,
        f.actorUserId,
      ]);
      await c.query(
        "UPDATE upload_sessions SET state='COMPLETE',storage_object_id=?,retired_storage_object_id=NULL,retired_purge_id=NULL,retired_at=NULL,terminal_at=NULL WHERE family_id=? AND id=?",
        [f.objectId, f.familyId, f.uploadId],
      );
      await c.query(
        "UPDATE media_items SET trashed_at=NULL,trashed_by_member_id=NULL,purge_after=NULL,purge_intent_id=NULL WHERE family_id=? AND id=?",
        [f.familyId, f.mediaId],
      );
      await c.query("DELETE FROM media_items WHERE family_id=? AND id<>?", [
        f.familyId,
        f.mediaId,
      ]);
      await c.query("DELETE FROM upload_sessions WHERE family_id=? AND id<>?", [
        f.familyId,
        f.uploadId,
      ]);
      await c.query("DELETE FROM purge_intents WHERE family_id=?", [
        f.familyId,
      ]);
      await c.query("DELETE FROM storage_objects WHERE family_id=? AND id<>?", [
        f.familyId,
        f.objectId,
      ]);
      await c.commit();
      await cleanupPhase6MigrationFixture(c, f);
      const [remaining] = await c.query<RowDataPacket[]>(
        "SELECT COUNT(*) n FROM families WHERE id=?",
        [f.familyId],
      );
      expect(Number(remaining[0]?.n)).toBe(0);
    } finally {
      c.release();
      gate?.close();
      gate = undefined;
      root?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });
  afterAll(() => db.pool.end());

  it("commits exact server deadline, CAS and one audit per operation, and preserves relations across Restore", async () => {
    await albums.putFavorite({
      actor: actor(owner),
      albumId,
      mediaId: f.mediaId,
    });
    const before = await row(),
      operation = randomUUID();
    const result = await trash(owner, "1", operation);
    expect(result.state).toBe("TRASHED");
    expect(result.lifecycleRevision).toBe("2");
    expect(result.purgeAfter!.getTime() - result.trashedAt!.getTime()).toBe(
      30 * 86400000,
    );
    expect(await trash(owner, "1", operation)).toEqual(result);
    await expect(trash(owner, "1")).rejects.toMatchObject({ statusCode: 409 });
    const after = await row();
    for (const key of [
      "storage_object_id",
      "source_upload_id",
      "generation",
      "recipe_id",
      "timeline_key",
      "uploaded_at",
    ])
      expect(after[key]).toEqual(before[key]);
    expect(
      await albums.listFamilyTimeline({
        actor: actor(owner),
        familyId: f.familyId,
        limit: 20,
      }),
    ).toEqual([]);
    expect(
      await albums.listAlbumMedia({ actor: actor(owner), albumId, limit: 20 }),
    ).toEqual([]);
    await expect(
      albums.getAlbumMedia({
        actor: actor(owner),
        albumId,
        mediaId: f.mediaId,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      albums.putFavorite({ actor: actor(owner), albumId, mediaId: f.mediaId }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      albums.addAlbumMedia({
        actor: actor(owner),
        albumId,
        mediaId: f.mediaId,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      albums.removeAlbumMedia({
        actor: actor(owner),
        albumId,
        mediaId: f.mediaId,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    const restoreOperation = randomUUID();
    expect(await restore("2", restoreOperation)).toMatchObject({
      state: "ACTIVE",
      lifecycleRevision: "3",
      trashedAt: null,
      purgeAfter: null,
    });
    expect(await restore("2", restoreOperation)).toMatchObject({
      state: "ACTIVE",
      lifecycleRevision: "3",
    });
    expect(
      (
        await albums.getAlbumMedia({
          actor: actor(owner),
          albumId,
          mediaId: f.mediaId,
        })
      ).isFavorite,
    ).toBe(true);
    const [audit] = await c.query<RowDataPacket[]>(
      "SELECT action FROM audit_logs WHERE family_id=? ORDER BY id",
      [f.familyId],
    );
    expect(audit.map((row) => row.action)).toEqual(["TRASH", "RESTORE"]);
    await expect(trash(owner, "1", operation)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("serves strict authenticated lifecycle routes and rejects unknown fields and mixed auth", async () => {
    const app = createApp({
      authService: { authenticate: async () => owner } as never,
      trashService: service,
      trustedOrigins: new Set(["https://family.test"]),
    });
    const url = `/api/v1/families/${f.familyId}/media/${f.mediaId}/trash`;
    const headers = {
      cookie: "__Host-family_session=synthetic",
      origin: "https://family.test",
      "content-type": "application/json",
    };
    const body = {
      selectedAlbumId: albumId,
      expectedLifecycleRevision: "1",
      operationId: randomUUID(),
    };
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers,
            payload: { ...body, includeTrash: true },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers: { ...headers, authorization: "Bearer synthetic" },
            payload: body,
          })
        ).statusCode,
      ).toBe(401);
      const result = await app.inject({
        method: "POST",
        url,
        headers,
        payload: body,
      });
      expect(result.statusCode).toBe(200);
      expect(Object.keys(result.json()).sort()).toEqual([
        "lifecycleRevision",
        "mediaId",
        "purgeAfter",
        "state",
        "trashedAt",
      ]);
      const listed = await app.inject({
        method: "GET",
        url: `/api/v1/families/${f.familyId}/trash`,
        headers: { cookie: headers.cookie },
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().items).toHaveLength(1);
      const restored = await app.inject({
        method: "POST",
        url: `/api/v1/families/${f.familyId}/trash/${f.mediaId}/restore`,
        headers,
        payload: { expectedLifecycleRevision: "2", operationId: randomUUID() },
      });
      expect(restored.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("checks selected FAMILY and explicit view, all delete grants, cross-family and no placement", async () => {
    await c.query("UPDATE albums SET visibility='FAMILY' WHERE id=?", [
      albumId,
    ]);
    await expect(trash(other)).rejects.toMatchObject({ statusCode: 403 });
    await c.query("UPDATE albums SET visibility='CUSTOM' WHERE id=?", [
      albumId,
    ]);
    await c.query(
      "INSERT INTO album_members (family_id,album_id,member_id,can_view,can_delete) VALUES (?,?,?,1,1)",
      [f.familyId, albumId, f.actorMemberId],
    );
    const second = await placement(f.memberId);
    await expect(trash(other)).rejects.toMatchObject({ statusCode: 403 });
    await c.query(
      "INSERT INTO album_members (family_id,album_id,member_id,can_view,can_delete) VALUES (?,?,?,1,1)",
      [f.familyId, second, f.actorMemberId],
    );
    await expect(
      service.mutate(other, {
        familyId: "18446744073709551615",
        mediaId: f.mediaId,
        selectedAlbumId: albumId,
        action: "TRASH",
        expectedLifecycleRevision: "1",
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      trash(other, "1", randomUUID(), "18446744073709551615"),
    ).rejects.toMatchObject({ statusCode: 404 });
    await trash(other);
    await restore();
    await c.query("DELETE FROM album_media WHERE family_id=?", [f.familyId]);
    await expect(trash(owner, "3")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects lifecycle uint64 overflow without changing state or audit", async () => {
    await c.query(
      "UPDATE media_items SET lifecycle_revision=18446744073709551615 WHERE id=?",
      [f.mediaId],
    );
    await expect(trash(owner, "18446744073709551615")).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await row()).trashed_at).toBeNull();
    const [audit] = await c.query<RowDataPacket[]>(
      "SELECT id FROM audit_logs WHERE family_id=?",
      [f.familyId],
    );
    expect(audit).toHaveLength(0);
  });

  it("dedupes real finalize into dormant canonical media under L, then resumes after Restore", async () => {
    const uploads = new MySqlUploadRepository(db.pool),
      nativeBegin = uploads.beginFinalize.bind(uploads);
    const content = new ContentCoordination(root, {
      familyId: f.familyId,
      sha256Hex: sha,
      byteSize: String(bytes.length),
    });
    let protectedFinalizes = 0;
    uploads.beginFinalize = async (input) => {
      expect(input.sha256.toString("hex")).toBe(sha);
      await expect(content.acquireLifecycle("X", 0)).rejects.toThrow(
        "COORD_ACQUIRE_TIMEOUT",
      );
      protectedFinalizes++;
      return nativeBegin(input);
    };
    const uploading = new UploadService(uploads, { state: "READ_WRITE", root });
    const upload = async () => {
      const id = randomBytes(16);
      await uploading.create(owner, {
        familyId: f.familyId,
        publicId: id,
        declaredSize: BigInt(bytes.length),
        filename: "synthetic.bin",
        reportedMime: "application/octet-stream",
      });
      await uploading.patch(owner, id, 0n, Readable.from([bytes]));
      const result = await uploading.finalize(owner, id);
      expect(result.state).toBe("COMPLETE");
      const receipt = await uploads.trustedState(id);
      expect(receipt.storageObjectId).toBe(f.objectId);
      const canonical = await new MySqlMediaRepository(
        db.pool,
      ).createOrGetCanonicalMedia({
        familyId: f.familyId,
        uploadId: receipt.id,
      });
      expect(canonical.created).toBe(false);
      expect(canonical.media.id).toBe(f.mediaId);
      expect(canonical.media.sourceUploadId).toBe(f.uploadId);
    };
    await upload();
    await trash();
    await upload();
    expect((await row()).revision).toBe("2");
    expect((await row()).trashed_at).not.toBeNull();
    const [placements] = await c.query<RowDataPacket[]>(
      "SELECT id FROM album_media WHERE family_id=?",
      [f.familyId],
    );
    expect(placements).toHaveLength(1);
    await restore();
    await upload();
    expect(protectedFinalizes).toBe(3);
    const life = await content.acquireLifecycle("X", 0);
    life.close();
  });

  it("rolls back lifecycle when same-transaction audit insertion fails", async () => {
    // Bypass the HTTP validator only here: strict MySQL rejects the oversized
    // audit identity after the lifecycle UPDATE, forcing a real TX rollback.
    const request = {
      actor: actor(owner),
      familyId: f.familyId,
      mediaId: f.mediaId,
      selectedAlbumId: albumId,
      expectedLifecycleRevision: "1",
      operationId: "a".repeat(37),
      action: "TRASH" as const,
    };
    const identity = await repo.preflight(request);
    await expect(repo.transition(request, identity)).rejects.toMatchObject({
      code: "ER_DATA_TOO_LONG",
    });
    expect(await row()).toMatchObject({
      revision: "1",
      trashed_at: null,
      purge_after: null,
    });
    const [audit] = await c.query<RowDataPacket[]>(
      "SELECT id FROM audit_logs WHERE family_id=?",
      [f.familyId],
    );
    expect(audit).toHaveLength(0);
  });

  it("7D private detail aggregates all live placements, preserves exact revision and role boundaries", async () => {
    const detail = () =>
      albums.getAlbumMedia({
        actor: actor(owner),
        albumId,
        mediaId: f.mediaId,
      });
    expect(await detail()).toMatchObject({
      lifecycleRevision: "1",
      capabilities: { canTrash: true },
    });
    const hidden = await placement(f.actorMemberId);
    for (const role of ["MEMBER", "ADMIN", "SUPER_ADMIN"]) {
      await c.query("UPDATE family_members SET role=? WHERE id=?", [
        role,
        f.memberId,
      ]);
      expect((await detail()).capabilities.canTrash).toBe(false);
    }
    await c.query(
      "UPDATE albums SET deleted_at=CURRENT_TIMESTAMP(3) WHERE id=?",
      [hidden],
    );
    await c.query(
      "UPDATE media_items SET lifecycle_revision=9007199254740993 WHERE id=?",
      [f.mediaId],
    );
    expect(await detail()).toMatchObject({
      lifecycleRevision: "9007199254740993",
      capabilities: { canTrash: true },
    });
    await c.query(
      "UPDATE media_items SET lifecycle_revision=18446744073709551615 WHERE id=?",
      [f.mediaId],
    );
    expect((await detail()).capabilities.canTrash).toBe(false);
  });

  it("7D Trash hints use current role, DB retention and session age without changing mutation authority", async () => {
    await trash();
    const eligibility = async () =>
      (await service.list(owner, { familyId: f.familyId, limit: 20 })).items[0]!
        .capabilities;
    expect((await eligibility()).permanentDeleteEligibility).toBe(
      "NOT_ALLOWED",
    );
    await c.query("UPDATE family_members SET role='ADMIN' WHERE id=?", [
      f.memberId,
    ]);
    expect((await eligibility()).permanentDeleteEligibility).toBe(
      "RETENTION_PENDING",
    );
    await c.query(
      "UPDATE media_items SET trashed_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 31 DAY),purge_after=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY) WHERE id=?",
      [f.mediaId],
    );
    expect((await eligibility()).permanentDeleteEligibility).toBe("READY");
    await c.query(
      "UPDATE sessions SET authenticated_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 15 MINUTE) WHERE id=?",
      [owner.identity.sessionId],
    );
    expect((await eligibility()).permanentDeleteEligibility).toBe(
      "REAUTH_REQUIRED",
    );
    await placement(f.actorMemberId);
    expect((await eligibility()).permanentDeleteEligibility).toBe(
      "NOT_ALLOWED",
    );
    await c.query(
      "UPDATE media_items SET lifecycle_revision=18446744073709551615 WHERE id=?",
      [f.mediaId],
    );
    expect(await eligibility()).toMatchObject({
      canRestore: false,
      permanentDeleteEligibility: "NOT_ALLOWED",
    });
  });

  it("requires selected discovery and all live delete grants; deleted placements stay dormant", async () => {
    const hidden = await placement(f.actorMemberId);
    await expect(trash(owner, "1", randomUUID(), hidden)).rejects.toMatchObject(
      { statusCode: 404 },
    );
    await expect(trash()).rejects.toMatchObject({ statusCode: 403 });
    await c.query(
      "UPDATE family_members SET role='SUPER_ADMIN' WHERE family_id=? AND id=?",
      [f.familyId, f.actorMemberId],
    );
    await expect(trash(other)).rejects.toMatchObject({ statusCode: 404 });
    await c.query(
      "UPDATE albums SET deleted_at=CURRENT_TIMESTAMP(3) WHERE family_id=? AND id=?",
      [f.familyId, hidden],
    );
    await trash();
    await restore();
    expect((await row()).revision).toBe("3");
    const [placements] = await c.query<RowDataPacket[]>(
      "SELECT id FROM album_media WHERE family_id=? AND media_id=?",
      [f.familyId, f.mediaId],
    );
    expect(placements).toHaveLength(2);
  });

  it("lists only current visible live placements once, and drops ACL-revoked Trash", async () => {
    const second = await placement(f.memberId, "FAMILY");
    await trash();
    const ownerList = await service.list(owner, {
      familyId: f.familyId,
      limit: 1,
    });
    expect(ownerList.items).toHaveLength(1);
    expect(ownerList.items[0]).toMatchObject({
      mediaId: f.mediaId,
      capabilities: { canRestore: true },
    });
    const visible = await service.list(other, {
      familyId: f.familyId,
      limit: 1,
    });
    expect(visible.items[0]?.capabilities.canRestore).toBe(false);
    expect(JSON.stringify(visible)).not.toMatch(
      /sha256|filename|storageObject|note|comment|albumId|thumbnail/u,
    );
    await c.query(
      "UPDATE albums SET visibility='CUSTOM' WHERE family_id=? AND id=?",
      [f.familyId, second],
    );
    expect(
      (await service.list(other, { familyId: f.familyId, limit: 1 })).items,
    ).toEqual([]);
    await expect(
      service.mutate(other, {
        familyId: f.familyId,
        mediaId: f.mediaId,
        action: "RESTORE",
        expectedLifecycleRevision: "2",
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("can Trash while an Original R-S read is live, but R-X waits for actual native cleanup", async () => {
    const reader = OriginalReader.open({
      mediaRoot: dir,
      expectedMarkerId: root.markerId,
    });
    const content = new ContentCoordination(root, {
      familyId: f.familyId,
      sha256Hex: sha,
      byteSize: String(bytes.length),
    });
    try {
      await reader.withVerifiedDownload(
        {
          familyId: f.familyId,
          sha256Hex: sha,
          byteSize: String(bytes.length),
        },
        { signal: new AbortController().signal },
        async (download) => {
          await trash();
          const life = await content.acquireLifecycle("X", 0);
          try {
            await expect(content.acquireRead(life, "X", 0)).rejects.toThrow(
              "COORD_ACQUIRE_TIMEOUT",
            );
            expect(await download.readNext()).toMatchObject({ final: true });
            const exclusive = await content.acquireRead(life, "X", 0);
            exclusive.close();
          } finally {
            life.close();
          }
        },
      );
    } finally {
      reader.close();
    }
  });

  it("uses real Original service R occupancy and permits a rechecked response after Trash commits before send", async () => {
    const native = OriginalReader.open({
      mediaRoot: dir,
      expectedMarkerId: root.markerId,
    });
    const content = new ContentCoordination(root, {
      familyId: f.familyId,
      sha256Hex: sha,
      byteSize: String(bytes.length),
    });
    const reader: OriginalDownloadReader = {
      withVerifiedDownload: (identity, options, use) =>
        native.withVerifiedDownload(identity, options, async (source) => {
          const life = await content.acquireLifecycle("X", 0);
          try {
            await expect(content.acquireRead(life, "X", 0)).rejects.toThrow(
              "COORD_ACQUIRE_TIMEOUT",
            );
          } finally {
            life.close();
          }
          return use(
            new Proxy(source, {
              get(target, key) {
                if (key === "readNext")
                  return async () => {
                    const buffer = await target.readNext();
                    if (buffer.final) {
                      const life = await content.acquireLifecycle("X", 0);
                      try {
                        const read = await content.acquireRead(life, "X", 0);
                        read.close();
                      } finally {
                        life.close();
                      }
                      await trash();
                    }
                    return buffer;
                  };
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          );
        }),
    };
    const app = createApp({
      authService: { authenticate: async () => owner } as never,
      albumService: new AlbumService(albums),
      originalDownloadService: new OriginalDownloadService(albums, reader),
      trustedOrigins: new Set(["https://family.test"]),
    });
    try {
      const result = await app.inject({
        method: "GET",
        url: `/api/v1/albums/${albumId}/media/${f.mediaId}/download/original`,
        headers: { cookie: "__Host-family_session=synthetic" },
      });
      expect(result.statusCode).toBe(200);
      expect(result.rawPayload).toEqual(bytes);
      expect((await row()).revision).toBe("2");
    } finally {
      await app.close();
      native.close();
    }
  });

  it("rejects old heartbeat/metadata/Derived READY after Trash and Restore without a generation bump", async () => {
    const queued = await jobs.enqueue({
      familyId: f.familyId,
      mediaId: f.mediaId,
      generation: 1n,
      recipeId: 1,
      jobType: "MEDIA_PROBE",
    });
    const worker = MySqlJobRepository.createWorkerIdentity(),
      claimed = await jobs.claimNext(worker, { jobType: "MEDIA_PROBE" });
    expect(claimed?.id).toBe(queued.job.id);
    expect(claimed?.lifecycleRevision).toBe(1n);
    const fence: LeaseFence = {
      familyId: f.familyId,
      mediaId: f.mediaId,
      jobId: claimed!.id,
      generation: 1n,
      workerId: worker,
      leaseEpoch: claimed!.leaseEpoch,
      lifecycleRevision: claimed!.lifecycleRevision!,
    };
    const prepared = await metadata.prepare(fence);
    expect(prepared).not.toBeNull();
    await trash();
    expect((await jobs.heartbeat(fence)).affectedRows).toBe(0);
    await restore();
    expect((await jobs.heartbeat(fence)).affectedRows).toBe(0);
    expect(await metadata.prepare(fence)).toBeNull();
    expect(await assets.commitSucceeded(fence, [])).toBe("STALE");
    expect((await row()).generation).toBe("1");
    await c.query(
      "UPDATE background_jobs SET locked_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 2 SECOND),heartbeat_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 2 SECOND),locked_until=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE family_id=? AND id=?",
      [f.familyId, claimed!.id],
    );
    await trash(owner, "3");
    expect((await jobs.recoverExpiredLease({ ...fence })).affectedRows).toBe(1);
  });

  it("keeps queued Trash dormant, then claims its current revision after Restore", async () => {
    await jobs.enqueue({
      familyId: f.familyId,
      mediaId: f.mediaId,
      generation: 1n,
      recipeId: 1,
      jobType: "MEDIA_PROBE",
    });
    await trash();
    expect(
      await jobs.claimNext(MySqlJobRepository.createWorkerIdentity(), {
        jobType: "MEDIA_PROBE",
      }),
    ).toBeNull();
    await restore();
    const claimed = await jobs.claimNext(
      MySqlJobRepository.createWorkerIdentity(),
      { jobType: "MEDIA_PROBE" },
    );
    expect(claimed?.mediaId).toBe(f.mediaId);
    expect(claimed?.lifecycleRevision).toBe(3n);
  });

  it.each(["private", "public"])(
    "denies %s derived bytes when Trash commits after initial authorization and read",
    async (mode) => {
      const real = await derivedFixture(),
        entered = barrier(),
        release = barrier();
      const content = new ContentCoordination(root, {
        familyId: f.familyId,
        sha256Hex: sha,
        byteSize: String(bytes.length),
      });
      const reader = {
        async read(identity: Parameters<typeof real.reader.read>[0]) {
          const buffer = await real.reader.read(identity);
          entered.resolve();
          await release.promise;
          return buffer;
        },
      };
      const reads = new MySqlDerivedReadRepository(db.pool);
      let operation: Promise<unknown>;
      if (mode === "private")
        operation = new DerivedReadService(reads, reader).serve(
          owner,
          f.mediaId,
          "preview",
        );
      else {
        const shares = new MySqlShareRepository(db.pool, albums),
          management = new ShareService(shares);
        const share = await management.createShare(
          owner,
          albumId,
          new Date(Date.now() + 86400000),
        );
        operation = new PublicShareService(
          management,
          shares,
          reads,
          reader,
        ).openDerived(share.token, f.mediaId, "preview");
      }
      void operation.catch(() => undefined);
      try {
        await entered.promise;
        const life = await content.acquireLifecycle("X", 0);
        try {
          const read = await content.acquireRead(life, "X", 0);
          read.close();
        } finally {
          life.close();
        }
        await trash();
        release.resolve();
        await expect(operation).rejects.toMatchObject({ statusCode: 404 });
      } finally {
        release.resolve();
        await operation.catch(() => undefined);
      }
    },
  );

  it("allows completed derived recheck before Trash, but rejects Original/Preview Trash-Restore ABA", async () => {
    const real = await derivedFixture(),
      reads = new MySqlDerivedReadRepository(db.pool);
    expect(
      (
        await new DerivedReadService(reads, real.reader).serve(
          owner,
          f.mediaId,
          "preview",
        )
      ).bytes,
    ).toEqual(real.output);
    const original = await albums.prepareOriginalDownload({
      actor: actor(owner),
      albumId,
      mediaId: f.mediaId,
    });
    const preview = await albums.preparePreviewDownload({
      actor: actor(owner),
      albumId,
      mediaId: f.mediaId,
    });
    await trash();
    await restore();
    await expect(
      albums.recheckOriginalDownload({
        actor: actor(owner),
        albumId,
        mediaId: f.mediaId,
        expected: original,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      albums.recheckPreviewDownload({
        actor: actor(owner),
        albumId,
        mediaId: f.mediaId,
        expected: preview,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
  });

  it("rejects new live references to synthetic PURGING storage", async () => {
    const uploads = new MySqlUploadRepository(db.pool),
      uploading = new UploadService(uploads, { state: "READ_WRITE", root });
    const id = randomBytes(16);
    await uploading.create(owner, {
      familyId: f.familyId,
      publicId: id,
      declaredSize: BigInt(bytes.length),
      filename: "synthetic-purging.bin",
      reportedMime: "application/octet-stream",
    });
    await uploading.patch(owner, id, 0n, Readable.from([bytes]));
    await c.query("UPDATE storage_objects SET state='PURGING' WHERE id=?", [
      f.objectId,
    ]);
    try {
      await expect(uploading.finalize(owner, id)).rejects.toMatchObject({
        status_code: 503,
        code: "STORAGE_UNAVAILABLE",
      });
      await expect(
        new MySqlMediaRepository(db.pool).createOrGetCanonicalMedia({
          familyId: f.familyId,
          uploadId: f.uploadId,
        }),
      ).rejects.toMatchObject({ reason: "STORAGE_UNAVAILABLE" });
      expect((await row()).revision).toBe("1");
    } finally {
      await c.query("UPDATE storage_objects SET state='AVAILABLE' WHERE id=?", [
        f.objectId,
      ]);
    }
  });

  it("filters hidden and deleted Trash before LIMIT and claims an active job behind Trash", async () => {
    const visible = await extraMedia(),
      hidden = await extraMedia("CUSTOM"),
      deleted = await extraMedia("FAMILY", true);
    await c.query("UPDATE albums SET visibility='FAMILY' WHERE id=?", [
      albumId,
    ]);
    await trash();
    for (const media of [visible.media, hidden.media, deleted.media])
      await c.query(
        `UPDATE media_items SET trashed_at=CURRENT_TIMESTAMP(3),trashed_by_member_id=?,purge_after=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 30 DAY),lifecycle_revision=2 WHERE id=?`,
        [f.memberId, media],
      );
    const first = await service.list(other, { familyId: f.familyId, limit: 1 });
    expect(first.items[0]?.mediaId).toBe(visible.media);
    const second = await service.list(other, {
      familyId: f.familyId,
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items[0]?.mediaId).toBe(f.mediaId);
    expect(
      (
        await service.list(other, {
          familyId: f.familyId,
          limit: 1,
          cursor: second.nextCursor!,
        })
      ).items,
    ).toEqual([]);
    const active = await extraMedia();
    const activeJob = await jobs.enqueue({
      familyId: f.familyId,
      mediaId: active.media,
      generation: 1n,
      recipeId: 1,
      jobType: "MEDIA_PROBE",
    });
    // A queued pre-Trash candidate remains stored ahead of the active candidate.
    await c.query(
      `INSERT INTO background_jobs (family_id,media_id,generation,recipe_id,job_type,state,available_at)
      VALUES (?,?,1,1,'MEDIA_PROBE','QUEUED',DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 SECOND))`,
      [f.familyId, f.mediaId],
    );
    const claim = await jobs.claimNext(
      MySqlJobRepository.createWorkerIdentity(),
      { jobType: "MEDIA_PROBE" },
    );
    expect(claim?.id).toBe(activeJob.job.id);
  });

  it("preserves every dormant relation and rejects common Phase6 mutation guards", async () => {
    await derivedFixture();
    const shares = new MySqlShareRepository(db.pool, albums),
      management = new ShareService(shares);
    await management.createShare(
      owner,
      albumId,
      new Date(Date.now() + 86400000),
    );
    await c.query("UPDATE family_members SET role='ADMIN' WHERE id=?", [
      f.memberId,
    ]);
    await albums.putFavorite({
      actor: actor(owner),
      albumId,
      mediaId: f.mediaId,
    });
    await albums.putFeatured({
      actor: actor(owner),
      albumId,
      mediaId: f.mediaId,
    });
    await albums.createAndApplyMediaTag({
      actor: actor(owner),
      albumId,
      mediaId: f.mediaId,
      name: "Synthetic tag",
      normalizedName: Buffer.from("synthetic tag"),
    });
    await albums.updateMediaNote({
      actor: actor(owner),
      albumId,
      mediaId: f.mediaId,
      note: "Synthetic note",
      expectedRevision: "1",
    });
    await albums.createMediaComment({
      actor: actor(owner),
      albumId,
      mediaId: f.mediaId,
      body: "Synthetic comment",
      admit: () => undefined,
    });
    const tables = [
      "album_media",
      "user_favorites",
      "family_featured",
      "media_tags",
      "tags",
      "comments",
      "derived_assets",
      "shares",
    ];
    const snapshot = async () =>
      Promise.all(
        tables.map(async (table) => {
          const [rows] = await c.query<RowDataPacket[]>(
            `SELECT * FROM ${table} WHERE family_id=? ORDER BY id`,
            [f.familyId],
          );
          return rows;
        }),
      );
    const before = await snapshot(),
      note = await row();
    await trash();
    expect(await snapshot()).toEqual(before);
    await expect(
      albums.putFeatured({ actor: actor(owner), albumId, mediaId: f.mediaId }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      albums.createAndApplyMediaTag({
        actor: actor(owner),
        albumId,
        mediaId: f.mediaId,
        name: "Other synthetic",
        normalizedName: Buffer.from("other synthetic"),
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      albums.updateMediaNote({
        actor: actor(owner),
        albumId,
        mediaId: f.mediaId,
        note: "Denied",
        expectedRevision: "2",
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      albums.createMediaComment({
        actor: actor(owner),
        albumId,
        mediaId: f.mediaId,
        body: "Denied",
        admit: () => undefined,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await restore();
    expect(await snapshot()).toEqual(before);
    expect((await row()).description).toBe(note.description);
    expect((await row()).note_revision).toBe(note.note_revision);
  });

  it("reuses dormant canonical media unchanged and rejects RETIRED reconstruction", async () => {
    const media = new MySqlMediaRepository(db.pool);
    await trash();
    const reused = await media.createOrGetCanonicalMedia({
      familyId: f.familyId,
      uploadId: f.uploadId,
    });
    expect(reused.created).toBe(false);
    expect(reused.media).toMatchObject({
      id: f.mediaId,
      sourceUploadId: f.uploadId,
      lifecycleRevision: 2n,
    });
    expect(reused.media.trashedAt).not.toBeNull();
    const purgeId = await insert(
      `INSERT INTO purge_intents (family_id,operation_id,media_id,storage_object_id,source_upload_id,
      lifecycle_revision,trashed_at,purge_after,request_source,actor_member_id,original_bytes)
      SELECT family_id,?,id,storage_object_id,source_upload_id,lifecycle_revision,trashed_at,purge_after,'MANUAL',?,?
      FROM media_items WHERE family_id=? AND id=?`,
      [randomUUID(), f.memberId, bytes.length, f.familyId, f.mediaId],
    );
    const retiredPublicId = randomBytes(16);
    const retired = await insert(
      `INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,
      computed_sha256,finalize_started_at,completed_at,expires_at,retired_storage_object_id,retired_purge_id,retired_at)
      VALUES (?,?,?,'synthetic-retired.bin',?,?,'RETIRED',?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),
        DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY),?,?,CURRENT_TIMESTAMP(3))`,
      [
        retiredPublicId,
        f.familyId,
        f.memberId,
        bytes.length,
        bytes.length,
        Buffer.from(sha, "hex"),
        f.objectId,
        purgeId,
      ],
    );
    const uploading = new UploadService(new MySqlUploadRepository(db.pool), {
      state: "UNAVAILABLE",
      reason: "STORAGE_NOT_CONFIGURED",
    });
    expect((await uploading.status(owner, retiredPublicId)).state).toBe(
      "RETIRED",
    );
    expect((await uploading.head(owner, retiredPublicId)).state).toBe(
      "RETIRED",
    );
    const writable = new UploadService(new MySqlUploadRepository(db.pool), {
      state: "READ_WRITE",
      root,
    });
    await expect(
      writable.patch(owner, retiredPublicId, 0n, Readable.from([bytes])),
    ).rejects.toMatchObject({ code: "UPLOAD_STATE_CONFLICT" });
    await expect(
      writable.finalize(owner, retiredPublicId),
    ).rejects.toMatchObject({ code: "UPLOAD_STATE_CONFLICT" });
    await expect(
      media.createOrGetCanonicalMedia({
        familyId: f.familyId,
        uploadId: retired,
      }),
    ).rejects.toMatchObject({ reason: "RECEIPT_NOT_COMPLETE" });
  });
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
